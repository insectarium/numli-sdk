import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_BASE_URL = 'https://numli.fr';

// numli.fr envoie un signe de vie toutes les 25 secondes : au-delà de 60 secondes sans rien, la connexion est morte
const HEARTBEAT_TIMEOUT_MS = 60 * 1000;

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30 * 1000;

// Le délai double à chaque échec, avec une part de hasard pour que tout le monde ne revienne pas au même instant
const retryDelay = (failures) => {
    const longest = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** failures);

    return longest / 2 + (Math.random() * longest) / 2;
};

const isExpired = ({ expireAt }) => Date.parse(expireAt) <= Date.now();

export class NumliError extends Error {
    constructor(message, { status, data, retryAfter } = {}) {
        super(message);
        this.name = 'NumliError';
        // Le statut HTTP : 404 pour un numéro déjà parti, 429 pour un quota atteint…
        this.status = status;
        // Le détail donné par numli.fr, comme retryAt pour un quota atteint
        this.data = data;
        // En secondes, quand numli.fr demande d'attendre
        this.retryAfter = retryAfter;
    }
}

const errorFrom = async (response) => {
    const body = await response.json().catch(() => null);
    const retryAfter = Number(response.headers.get('retry-after')) || undefined;

    return new NumliError(body?.statusMessage ?? `HTTP ${response.status}`, {
        status: response.status,
        data: body?.data,
        retryAfter,
    });
};

// Une ligne du flux : un commentaire (le signe de vie) ou un champ du message en cours
const readField = (line, message) => {
    if (line.startsWith(':')) return;

    const colon = line.indexOf(':');
    if (colon === -1) return;

    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');

    if (field === 'id' || field === 'event') message[field] = value;
    if (field === 'data') message.data = message.data === undefined ? value : `${message.data}\n${value}`;
};

export class Numli extends EventEmitter {
    #apiKey;
    #baseUrl;
    #heartbeatTimeout;
    // Les numéros disponibles, par numéro
    #known = new Map();
    #lastEventId = null;
    #started = false;
    #closed = false;
    #closing = new AbortController();
    // Quelque chose est arrivé sur la connexion en cours : le délai de reconnexion repart de zéro
    #alive = false;

    constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, heartbeatTimeout = HEARTBEAT_TIMEOUT_MS } = {}) {
        // Un écouteur async qui échoue passe par la méthode nodejs.rejection plus bas, au lieu de faire tomber le processus
        super({ captureRejections: true });

        if (!apiKey) throw new TypeError('apiKey est obligatoire');

        this.#apiKey = apiKey;
        this.#baseUrl = baseUrl;
        this.#heartbeatTimeout = heartbeatTimeout;

        // Un code qui ne fait que réserver n'ouvre aucun flux
        this.on('newListener', (event) => {
            if (typeof event === 'string' && event.startsWith('number.')) this.connect();
        });
    }

    // La liste à jour, sans les numéros expirés. Vide tant que la connexion n'a rien reçu
    get numbers() {
        this.#removeExpired();

        return [...this.#known.values()];
    }

    // Ouvre le flux. Inutile dès qu'un écouteur number.* est branché
    connect() {
        if (this.#started || this.#closed) return;

        this.#started = true;
        this.#run();
    }

    // Ferme le flux pour de bon
    close() {
        this.#closed = true;
        this.#closing.abort();
    }

    // Réserve un numéro. Renvoie { accessUrl, operator, expireAt }, lève NumliError en cas de refus
    async claim(number, { reference } = {}) {
        const response = await fetch(`${this.#baseUrl}/api/claim`, {
            method: 'POST',
            headers: { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ number, ...(reference && { reference }) }),
        });

        if (!response.ok) throw await errorFrom(response);

        return await response.json();
    }

    async #run() {
        let failures = 0;

        while (!this.#closed) {
            let delay = null;
            this.#alive = false;

            try {
                await this.#listen();
            } catch (error) {
                if (this.#closed) return;

                this.#report(error);

                // Une clé refusée le restera : réessayer ne servirait à rien
                if (error.status === 401) return;

                if (error.retryAfter) delay = error.retryAfter * 1000;
            }

            if (this.#alive) failures = 0;

            await sleep(delay ?? retryDelay(failures++), undefined, { signal: this.#closing.signal }).catch(() => {});
        }
    }

    // Une connexion, jusqu'à sa fin : se termine si numli.fr ferme le flux, lève une erreur sinon
    async #listen() {
        const connection = new AbortController();
        const abort = () => connection.abort();
        this.#closing.signal.addEventListener('abort', abort, { once: true });

        let silent = false;
        let watchdog;

        const watch = () => {
            clearTimeout(watchdog);
            watchdog = setTimeout(() => {
                silent = true;
                connection.abort();
            }, this.#heartbeatTimeout);
        };

        try {
            watch();

            const response = await fetch(`${this.#baseUrl}/api/number/stream`, {
                headers: {
                    authorization: `Bearer ${this.#apiKey}`,
                    accept: 'text/event-stream',
                    ...(this.#lastEventId && { 'last-event-id': this.#lastEventId }),
                },
                signal: connection.signal,
            });

            if (!response.ok) throw await errorFrom(response);

            watch();
            await this.#read(response.body, watch);
        } catch (error) {
            if (silent) throw new NumliError('Plus aucun signe de vie de numli.fr, reconnexion');

            throw error;
        } finally {
            clearTimeout(watchdog);
            this.#closing.signal.removeEventListener('abort', abort);
        }
    }

    async #read(body, onData) {
        const decoder = new TextDecoder();
        let buffer = '';
        let message = {};

        for await (const chunk of body) {
            this.#alive = true;
            onData();

            buffer += decoder.decode(chunk, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const text = line.endsWith('\r') ? line.slice(0, -1) : line;

                if (text) {
                    readField(text, message);
                } else {
                    this.#dispatch(message);
                    message = {};
                }
            }
        }
    }

    #dispatch({ id, event, data }) {
        if (id) this.#lastEventId = id;
        if (!data) return;

        try {
            const { numbers } = JSON.parse(data);

            if (event === 'number.sync') this.#applySync(numbers);
            if (event === 'number.create') this.#applyCreate(numbers);
            if (event === 'number.delete') this.#applyDelete(numbers);
        } catch (error) {
            this.#report(error);
        }
    }

    // Toute la liste, à la première connexion ou après une longue coupure : elle remplace la précédente. Jamais d'appel par
    // numéro ici : 10 000 appels simultanés satureraient la base de l'abonné
    #applySync(numbers) {
        const current = numbers.filter((listed) => !isExpired(listed));

        this.#known = new Map(current.map((listed) => [listed.number, listed]));

        this.#emit('number.sync', current);
    }

    // Un appel par numéro. Une reprise peut renvoyer un événement déjà reçu, ou un numéro expiré entre-temps
    #applyCreate(numbers) {
        this.#removeExpired();

        for (const listed of numbers) {
            if (isExpired(listed) || this.#known.has(listed.number)) continue;

            this.#known.set(listed.number, listed);
            this.#emit('number.create', listed);
        }
    }

    #applyDelete(numbers) {
        for (const number of numbers) {
            if (this.#known.delete(number)) this.#emit('number.delete', { number });
        }
    }

    #removeExpired() {
        for (const [number, listed] of this.#known) {
            if (isExpired(listed)) this.#known.delete(number);
        }
    }

    // Une erreur dans un écouteur de l'abonné ne doit pas couper le flux
    #emit(event, payload) {
        try {
            this.emit(event, payload);
        } catch (error) {
            this.#report(error);
        }
    }

    // Sans écouteur, EventEmitter lèverait l'erreur et ferait tomber le processus de l'abonné
    #report(error) {
        if (this.listenerCount('error')) this.emit('error', error);
        else console.error(`[numli] ${error.message}`);
    }

    [Symbol.for('nodejs.rejection')](error) {
        this.#report(error);
    }
}
