import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { Numli, NumliError } from './index.js';

const KEY = 'sk_test';
const FUTURE = '2099-01-01T10:00:00.000Z';
const PAST = '2020-01-01T10:00:00.000Z';

let server;
let baseUrl;
// Les appels reçus par le serveur de test, dans l'ordre
let requests;
// Ce que le serveur fait d'une connexion au flux, selon son rang : (res, request) => …
let onStream;
let onClaim;
let clients;

before(async () => {
    server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            const request = { method: req.method, url: req.url, headers: req.headers, body };
            requests.push(request);

            if (req.url === '/api/claim') return onClaim(res, request);

            res.on('close', () => clients.delete(res));
            clients.add(res);
            onStream(res, request, requests.filter(({ url }) => url === '/api/number/stream').length);
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server.closeAllConnections();
    server.close();
});

let numli;

beforeEach(() => {
    requests = [];
    clients = new Set();
    onStream = (res) => open(res);
    onClaim = (res) => res.writeHead(500).end();
});

afterEach(() => {
    numli?.close();
    numli = null;
    for (const res of clients) res.destroy();
});

const create = (options = {}) => {
    numli = new Numli({ apiKey: KEY, baseUrl, ...options });

    return numli;
};

const open = (res) => res.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders();

const frame = (event, numbers, id) => `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify({ numbers })}\n\n`;

const listed = (number, expireAt = FUTURE) => ({ number, expireAt });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (condition, label = 'condition') => {
    const deadline = Date.now() + 5000;

    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`Délai dépassé : ${label}`);
        await sleep(5);
    }
};

// Note tout ce que le package émet, dans l'ordre
const record = (client, events = ['number.create', 'number.delete', 'number.sync']) => {
    const emitted = [];
    for (const event of events) client.on(event, (payload) => emitted.push([event, payload]));

    return emitted;
};

const streamCalls = () => requests.filter(({ url }) => url === '/api/number/stream');

test('sans écouteur, aucune connexion : un code qui ne fait que réserver n’ouvre pas de flux', async () => {
    onClaim = (res, request) => res.end(JSON.stringify({ accessUrl: 'https://numli.fr/api/claim/c1' }));

    await create().claim('0612345678');
    await sleep(30);

    assert.equal(streamCalls().length, 0);
});

test('le premier écouteur ouvre le flux, avec la clé, une seule fois', async () => {
    const client = create();
    client.on('number.create', () => {});
    client.on('number.delete', () => {});

    await waitUntil(() => streamCalls().length === 1);
    await sleep(20);

    assert.equal(streamCalls().length, 1);
    assert.equal(streamCalls()[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(streamCalls()[0].headers['last-event-id'], undefined);
});

test('la liste complète n’arrive que par number.sync : aucun appel par numéro à la connexion', async () => {
    onStream = (res) => {
        open(res);
        res.write(frame('number.sync', [listed('0612345678'), listed('0698765432')], '1-0'));
    };

    const emitted = record(create());
    await waitUntil(() => emitted.length === 1);
    await sleep(20);

    const numbers = [listed('0612345678'), listed('0698765432')];
    assert.deepEqual(emitted, [['number.sync', numbers]]);
    assert.deepEqual(numli.numbers, numbers);
});

test('le direct : un nouveau numéro entre dans la liste, un numéro retiré en sort', async () => {
    onStream = (res) => {
        open(res);
        res.write(frame('number.sync', [listed('0612345678')], '1-0'));
        res.write(frame('number.create', [listed('0698765432')], '2-0'));
        res.write(frame('number.delete', ['0612345678'], '3-0'));
    };

    const emitted = record(create(), ['number.create', 'number.delete']);
    await waitUntil(() => emitted.length === 2);

    assert.deepEqual(emitted, [
        ['number.create', listed('0698765432')],
        ['number.delete', { number: '0612345678' }],
    ]);
    assert.deepEqual(numli.numbers, [listed('0698765432')]);
});

test('un événement à plusieurs numéros fait un appel par numéro', async () => {
    onStream = (res) => {
        open(res);
        res.write(frame('number.create', [listed('0612345678'), listed('0698765432')], '1-0'));
        res.write(frame('number.delete', ['0612345678', '0698765432'], '2-0'));
    };

    const emitted = record(create(), ['number.create', 'number.delete']);
    await waitUntil(() => emitted.length === 4);

    assert.deepEqual(emitted, [
        ['number.create', listed('0612345678')],
        ['number.create', listed('0698765432')],
        ['number.delete', { number: '0612345678' }],
        ['number.delete', { number: '0698765432' }],
    ]);
});

test('un événement reçu deux fois n’est émis qu’une fois', async () => {
    onStream = (res) => {
        open(res);
        res.write(frame('number.create', [listed('0612345678')], '1-0'));
        res.write(frame('number.create', [listed('0612345678'), listed('0698765432')], '2-0'));
        res.write(frame('number.delete', ['0655555555'], '3-0'));
        res.write(frame('number.delete', ['0698765432'], '4-0'));
        res.write(frame('number.delete', ['0698765432'], '5-0'));
    };

    const emitted = record(create(), ['number.create', 'number.delete']);
    await waitUntil(() => emitted.length >= 3);
    await sleep(20);

    assert.deepEqual(emitted, [
        ['number.create', listed('0612345678')],
        ['number.create', listed('0698765432')],
        ['number.delete', { number: '0698765432' }],
    ]);
});

test('un message coupé en deux morceaux, ou en fins de ligne CRLF, est lu en entier', async () => {
    onStream = async (res) => {
        open(res);
        const text = frame('number.create', [listed('0612345678')], '1-0');
        res.write(text.slice(0, 15));
        await sleep(10);
        res.write(text.slice(15));
        res.write(frame('number.create', [listed('0698765432')], '2-0').replaceAll('\n', '\r\n'));
    };

    const emitted = record(create(), ['number.create']);
    await waitUntil(() => emitted.length === 2);

    assert.deepEqual(emitted[1], ['number.create', listed('0698765432')]);
});

test('reconnexion : le dernier identifiant est renvoyé', async () => {
    onStream = (res, _request, rank) => {
        open(res);
        if (rank === 1) res.end(frame('number.create', [listed('0612345678')], '7-3'));
    };

    create().on('number.create', () => {});
    await waitUntil(() => streamCalls().length === 2);

    assert.equal(streamCalls()[1].headers['last-event-id'], '7-3');
});

test('après une longue coupure, number.sync remplace toute la liste, sans appel par numéro', async () => {
    onStream = (res, _request, rank) => {
        open(res);
        if (rank === 1) res.end(frame('number.sync', [listed('0612345678'), listed('0698765432')], '1-0'));
        else res.write(frame('number.sync', [listed('0698765432'), listed('0655555555')], '2-0'));
    };

    const emitted = record(create());
    await waitUntil(() => emitted.length === 2);
    await sleep(20);

    assert.deepEqual(emitted.map(([event]) => event), ['number.sync', 'number.sync']);
    assert.deepEqual(numli.numbers, [listed('0698765432'), listed('0655555555')]);
});

test('un numéro expiré sort de numbers, sans number.delete : l’abonné se fie à expireAt', async () => {
    const soon = new Date(Date.now() + 60).toISOString();

    onStream = (res, _request, rank) => {
        open(res);
        if (rank === 1) {
            res.end(frame('number.sync', [listed('0612345678', soon), listed('0698765432')], '1-0'));
        } else {
            setTimeout(() => res.write(frame('number.sync', [listed('0698765432')], '2-0')), 80);
        }
    };

    const emitted = record(create(), ['number.create', 'number.delete', 'number.sync']);
    await waitUntil(() => emitted.filter(([event]) => event === 'number.sync').length === 2);

    assert.deepEqual(numli.numbers, [listed('0698765432')]);
    assert.equal(emitted.filter(([event]) => event === 'number.delete').length, 0);
    assert.deepEqual(emitted.at(-1), ['number.sync', [listed('0698765432')]]);
});

test('un numéro déjà expiré à l’arrivée n’est pas annoncé', async () => {
    onStream = (res) => {
        open(res);
        res.write(frame('number.create', [listed('0612345678', PAST), listed('0698765432')], '1-0'));
    };

    const emitted = record(create(), ['number.create']);
    await waitUntil(() => emitted.length === 1);
    await sleep(20);

    assert.deepEqual(emitted, [['number.create', listed('0698765432')]]);
});

test('401 : le flux s’arrête au lieu de réessayer une clé refusée', async () => {
    onStream = (res) => res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"statusMessage":"Invalid API key"}');

    const errors = [];
    const client = create();
    client.on('error', (error) => errors.push(error));
    client.on('number.create', () => {});

    await waitUntil(() => errors.length === 1);
    await sleep(1200);

    assert.ok(errors[0] instanceof NumliError);
    assert.equal(errors[0].status, 401);
    assert.equal(streamCalls().length, 1);
});

test('429 : le package attend le délai demandé par le serveur', async () => {
    onStream = (res, _request, rank) => {
        if (rank === 1) return res.writeHead(429, { 'Retry-After': '2' }).end();
        open(res);
    };

    const client = create();
    client.on('error', () => {});
    client.on('number.create', () => {});

    await sleep(1200);
    assert.equal(streamCalls().length, 1);

    await waitUntil(() => streamCalls().length === 2);
});

test('une erreur du serveur est réessayée', async () => {
    onStream = (res, _request, rank) => {
        if (rank === 1) return res.writeHead(502).end();
        open(res);
        res.write(frame('number.create', [listed('0612345678')], '1-0'));
    };

    const client = create();
    client.on('error', () => {});
    const emitted = record(client, ['number.create']);

    await waitUntil(() => emitted.length === 1);
});

test('sans écouteur d’erreur, une erreur ne fait pas tomber le processus de l’abonné', async () => {
    const original = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));

    try {
        onStream = (res) => res.writeHead(401).end('{"statusMessage":"Invalid API key"}');

        create().on('number.create', () => {});
        await waitUntil(() => logged.length === 1);

        assert.match(logged[0], /Invalid API key/);
    } finally {
        console.error = original;
    }
});

test('une connexion muette est considérée comme morte, puis rouverte', async () => {
    create({ heartbeatTimeout: 100 }).on('number.create', () => {});

    await waitUntil(() => streamCalls().length === 2);
});

test('les signes de vie gardent la connexion et ne produisent aucun événement', async () => {
    onStream = (res) => {
        open(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 30);
        res.on('close', () => clearInterval(ping));
    };

    const emitted = record(create({ heartbeatTimeout: 100 }));
    await sleep(350);

    assert.equal(streamCalls().length, 1);
    assert.deepEqual(emitted, []);
});

test('un écouteur qui lève une erreur ne coupe pas le flux, ni les numéros suivants du même événement', async () => {
    onStream = (res) => {
        open(res);
        res.write(frame('number.create', [listed('0612345678'), listed('0698765432')], '1-0'));
    };

    const errors = [];
    const seen = [];
    const client = create();
    client.on('error', (error) => errors.push(error));
    client.on('number.create', ({ number }) => {
        seen.push(number);
        if (seen.length === 1) throw new Error('Bug de l’abonné');
    });

    await waitUntil(() => seen.length === 2);

    assert.equal(errors[0].message, 'Bug de l’abonné');
    assert.equal(streamCalls().length, 1);
});

test('un écouteur async qui échoue ne coupe pas le flux et ne fait pas tomber le processus', async () => {
    onStream = (res) => {
        open(res);
        res.write(frame('number.create', [listed('0612345678')], '1-0'));
        res.write(frame('number.create', [listed('0698765432')], '2-0'));
    };

    const errors = [];
    const seen = [];
    const client = create();
    client.on('error', (error) => errors.push(error));
    client.on('number.create', async ({ number }) => {
        seen.push(number);
        if (seen.length === 1) throw new Error('Base de l’abonné injoignable');
    });

    await waitUntil(() => seen.length === 2 && errors.length === 1);

    assert.equal(errors[0].message, 'Base de l’abonné injoignable');
    assert.equal(streamCalls().length, 1);
});

test('close : la connexion se ferme et ne se rouvre pas', async () => {
    const client = create();
    client.on('number.create', () => {});
    await waitUntil(() => clients.size === 1);

    client.close();

    await waitUntil(() => clients.size === 0);
    await sleep(1200);
    assert.equal(streamCalls().length, 1);
});

test('claim : renvoie le lien d’accès, avec la clé, le numéro et la référence', async () => {
    onClaim = (res) =>
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({ accessUrl: 'https://numli.fr/api/claim/c1', expireAt: FUTURE }),
        );

    const claim = await create().claim('0612345678', { reference: 'commande-1042' });

    assert.deepEqual(claim, { accessUrl: 'https://numli.fr/api/claim/c1', expireAt: FUTURE });

    const [request] = requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(JSON.parse(request.body), { number: '0612345678', reference: 'commande-1042' });
});

test('claim : sans référence, le corps ne contient que le numéro', async () => {
    onClaim = (res) => res.end('{}');

    await create().claim('0612345678');

    assert.deepEqual(JSON.parse(requests[0].body), { number: '0612345678' });
});

test('claim : un numéro déjà parti lève une erreur avec son statut', async () => {
    onClaim = (res) => res.writeHead(404).end('{"statusMessage":"Number not available"}');

    await assert.rejects(create().claim('0612345678'), (error) => {
        assert.ok(error instanceof NumliError);
        assert.equal(error.status, 404);
        assert.equal(error.message, 'Number not available');

        return true;
    });
});

test('claim : un quota atteint donne retryAt dans data', async () => {
    onClaim = (res) =>
        res.writeHead(429).end(JSON.stringify({ statusMessage: 'Daily quota reached', data: { retryAt: FUTURE } }));

    await assert.rejects(create().claim('0612345678'), (error) => {
        assert.equal(error.status, 429);
        assert.deepEqual(error.data, { retryAt: FUTURE });

        return true;
    });
});

test('une clé absente est refusée tout de suite', () => {
    assert.throws(() => new Numli({}), /apiKey/);
});
