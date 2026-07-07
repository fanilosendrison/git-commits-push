# Spécification Technique : Algorithme "Commande" (Order)

*Pour le contexte philosophique et les décisions d'architecture, voir le Rationale : [docs/order-rationale.md](../docs/order-rationale.md).*

## 1. Arborescence Cible

- **Utilitaire métier :** `src/utils/order.ts`
- **Dossier d'état système :** `~/.agents/state/git-commits-push/orders/`
  - Fichier verrou : `running.lock` (contient des métadonnées JSON : `runId`, `callerName`, `timestamp`)
  - Fichiers de file d'attente : `order-<timestamp>-<uuid>.flag`

## 2. Comportement du Système

- **Règle 1 (Acquisition & File d'attente) :** Si une session démarre et que `running.lock` appartient à un autre processus, elle doit s'enregistrer dans la file d'attente (en créant un fichier `order-*.flag`), calculer sa position, notifier l'utilisateur (ou l'agent parent via stdout), puis s'arrêter avec un code de succès (`exit(0)`).
- **Règle 2 (Passage de relais) :** Lorsqu'une session active se termine (succès ou échec après épuisement des retries), elle doit libérer le verrou. S'il reste des commandes dans le dossier d'état, elle doit supprimer la plus ancienne et relancer la commande CLI globale de l'outil (`git-commits-push`) en processus arrière-plan (spawn détaché).
- **Règle 3 (Nettoyage Best-Effort) :** L'application doit s'efforcer de supprimer son `running.lock` en interceptant les signaux d'arrêt brutaux (ex: `SIGINT`, `uncaughtException`).
- **Règle 4 (Sécurité Anti-Deadlock & Heartbeat) :** Pour détecter avec certitude les crashs brutaux sans timeout arbitraire, l'outil implémente un "Heartbeat" (battement de cœur).
  - L'orchestrateur et le bridge doivent mettre à jour la date de modification (`mtime`) de `running.lock` toutes les 10 secondes.
  - Le relais du Heartbeat se passe de l'orchestrateur au bridge au moment de la délégation.
  - Si une nouvelle session trouve un `running.lock` dont le `mtime` est plus vieux que 40 secondes, la session est certifiée morte. Elle écrase alors le verrou orphelin et s'exécute normalement.

## 3. Contrats I/O (Exportations de `src/utils/order.ts`)

### `checkAndAcquireLock(runId: string, forceUnlock: boolean): "ACQUIRED" | "QUEUED"`
- **Rôle :** Tente d'acquérir le verrou exclusif ou place la demande en file d'attente.
- **Entrées :**
  - `runId` (string) : L'identifiant Turnlock de la session courante (utilisé pour autoriser un `--resume` sans se bloquer soi-même).
  - `forceUnlock` (boolean) : Si `true`, détruit tout état système existant avant de s'approprier le verrou.
- **Sortie :** 
  - `"ACQUIRED"` : Verrou posé avec succès.
  - `"QUEUED"` : Un verrou concurrent existait. La session s'est insérée dans la file d'attente. L'orchestrateur fera un `process.exit(0)` immédiat en affichant : 
    `"Une session est déjà en cours (gérée par : [callerName]). Commande enregistrée. Vous êtes en position Y dans la file d'attente. Vos commits seront poussés de manière asynchrone par la session parente."`

### `releaseLockAndTriggerNext(runId: string): void`
- **Rôle :** Libère le verrou courant de manière sécurisée et amorce le traitement de la commande suivante.
- **Entrées :**
  - `runId` (string) : Identifiant de la session courante (pour éviter de supprimer le verrou d'un autre si on s'est fait écraser).
- **Sortie :** Ne retourne rien. Si une commande est en attente, le script lance un `spawn` détaché de `bun run start` avec le bon `cwd` (`/Users/famillesendrison/.agents/skills/git-commits-push`).

### `startHeartbeat(): void` / `stopHeartbeat(): void`
- **Rôle :** Fonctions à appeler au démarrage et à la fin de l'orchestrateur (et du bridge) pour maintenir la date de modification du fichier `running.lock` à jour toutes les 10 secondes.

### `setupCleanupHooks(): void`
- **Rôle :** Initialise les écouteurs sur le processus hôte (`SIGINT`, `uncaughtException`) pour garantir la suppression propre du fichier lock en cas d'interruption interceptable, évitant ainsi d'attendre les 40 secondes du Heartbeat.
