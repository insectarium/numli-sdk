# @numli/sdk

Recevez les numéros de mobile disponibles sur [numli.fr](https://numli.fr) en direct, et réservez-les depuis votre serveur.

Il faut Node.js 18 ou plus. Votre clé API se trouve sur la page Configuration du tableau de bord : gardez-la sur votre serveur, jamais dans une page web. Recevoir les numéros ne demande que cette clé. Les réserver demande aussi un abonnement actif et une URL d'erreur.

```bash
npm install @numli/sdk
```

```js
import { Numli } from '@numli/sdk';

const numli = new Numli({ apiKey: process.env.NUMLI_API_KEY });

// Toute la liste, à la connexion et après une longue coupure : remplacez la vôtre
numli.on('number.sync', (numbers) => {
    // [{ number: '0612345678', expireAt: '2026-11-05T15:32:08.000Z' }, …]
});

// Un numéro qui vient d'apparaître
numli.on('number.create', ({ number, expireAt }) => {});

// Un numéro qui ne peut plus être demandé
numli.on('number.delete', ({ number }) => {});

numli.on('error', (error) => console.error(error.message));
```

Le flux s'ouvre au premier écouteur `number.*`. Votre programme doit rester allumé pour le garder ouvert.

Un numéro qui expire ne reçoit pas de `number.delete` : retirez-le vous-même une fois son `expireAt` passé.

## Sans base de données

`numli.numbers` donne la liste à jour, sans les numéros expirés. Elle suffit pour les afficher :

```js
numli.connect();

app.get('/numeros', (req, res) => res.json(numli.numbers));
```

## Réserver un numéro

```js
import { NumliError } from '@numli/sdk';

try {
    const { accessUrl } = await numli.claim('0612345678', { reference: 'commande-1042' });

    // Envoyez votre client vers accessUrl
} catch (error) {
    if (error instanceof NumliError && error.status === 404) {
        // Un autre abonné l'a réservé avant vous
    }
}
```

| `error.status` | Signification                                                          |
| -------------- | ---------------------------------------------------------------------- |
| 400            | Le numéro ou la référence n'est pas valide                             |
| 401            | Clé API absente ou invalide                                            |
| 403            | Aucun abonnement actif, ou URL d'erreur à renseigner                   |
| 404            | Le numéro n'est plus disponible                                        |
| 429            | Quota atteint : `error.data.retryAt` indique quand une place se libère |

`claim` n'ouvre aucun flux : un code qui ne fait que réserver n'a pas besoin de rester connecté.

## Après une coupure

Le package se reconnecte tout seul. Après une courte coupure, il reçoit ce qu'il a manqué, en `number.create` et `number.delete`. Après une longue coupure, il reçoit `number.sync`.

| Erreur                 | Ce que fait le package                  |
| ---------------------- | --------------------------------------- |
| 401, clé refusée       | S'arrête                                |
| 429, trop d'appels     | Attend le délai demandé                 |
| Autre, ou réseau coupé | Réessaie, jusqu'à 30 secondes d'attente |

Les erreurs partent vers l'événement `error`, ou vers la console si vous ne l'écoutez pas. Une erreur dans l'un de vos écouteurs y part aussi, sans couper le flux.

`numli.close()` ferme le flux pour de bon.

## Sans Node.js

Le flux est une simple connexion [Server-Sent Events](https://developer.mozilla.org/fr/docs/Web/API/Server-sent_events). `number.sync` porte toute la liste, `{ "numbers": [...] }`. Chaque `number.create` porte un numéro, `{ "number", "expireAt" }`, et chaque `number.delete` aussi, `{ "number" }` :

```bash
curl -N https://numli.fr/api/number/stream -H "Authorization: Bearer sk_…"
```

Si votre hébergement ne peut pas garder une connexion ouverte, `GET /api/number` avec le même en-tête renvoie toute la liste, à lire depuis une tâche planifiée. Le détail de chaque appel est sur la page API du tableau de bord.
