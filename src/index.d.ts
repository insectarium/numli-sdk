import { EventEmitter } from 'node:events';

export interface ListedNumber {
    /** 06 ou 07 puis 8 chiffres, comme 0612345678 */
    number: string;
    /** Date ISO 8601 après laquelle le numéro ne peut plus être demandé */
    expireAt: string;
}

export interface Claim {
    /** L'identifiant de la demande, à passer à getClaim */
    id: string;
    /** Le lien où envoyer votre client, valable jusqu'à expireAt */
    accessUrl: string;
    operator: string;
    expireAt: string;
}

export interface ClaimDetails extends Claim {
    number: string;
    reference: string | null;
    /**
     * requested : lien pas encore ouvert.
     * validated : lien ouvert à temps, sans garantie que le numéro ait été acheté.
     * expired : lien ouvert trop tard, ou jamais ouvert à temps.
     */
    status: 'requested' | 'validated' | 'expired';
    createdAt: string;
    /** La première ouverture du lien, null s'il n'a jamais été ouvert */
    openedAt: string | null;
}

export interface NumliOptions {
    apiKey: string;
    /** https://numli.fr par défaut */
    baseUrl?: string;
    /** Millisecondes sans signe de vie avant de rouvrir la connexion, 60 000 par défaut */
    heartbeatTimeout?: number;
}

export class NumliError extends Error {
    /** Le statut HTTP : 404 pour un numéro déjà parti, 429 pour un quota atteint… */
    status?: number;
    /** Le détail donné par numli.fr, comme retryAt pour un quota atteint */
    data?: { retryAt?: string | null } & Record<string, unknown>;
    /** En secondes, quand numli.fr demande d'attendre */
    retryAfter?: number;
}

export class Numli extends EventEmitter {
    constructor(options: NumliOptions);

    /** La liste à jour, sans les numéros expirés */
    readonly numbers: ListedNumber[];

    /** Ouvre le flux. Inutile dès qu'un écouteur number.* est branché */
    connect(): void;

    /** Ferme le flux pour de bon */
    close(): void;

    /** Réserve un numéro. Lève NumliError en cas de refus */
    claim(number: string, options?: { reference?: string }): Promise<Claim>;

    /** Lit une demande de votre compte, sans rien y changer. Lève NumliError en cas de refus */
    getClaim(id: string): Promise<ClaimDetails>;

    /** Toute la liste, à la connexion ou après une longue coupure : remplacez la vôtre */
    on(event: 'number.sync', listener: (numbers: ListedNumber[]) => void | Promise<void>): this;
    /** Un numéro qui vient d'apparaître */
    on(event: 'number.create', listener: (listed: ListedNumber) => void | Promise<void>): this;
    /** Un numéro qui ne peut plus être demandé. Un numéro qui expire n'en reçoit pas : fiez-vous à expireAt */
    on(event: 'number.delete', listener: (removed: { number: string }) => void | Promise<void>): this;
    /** Une connexion refusée ou coupée. Le flux se rouvre tout seul, sauf pour une clé refusée (status 401) */
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
}
