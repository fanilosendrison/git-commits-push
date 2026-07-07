# Rationale : L'Algorithme "Commande" (Order) pour git-commits-push

## Objectif
Résoudre les problèmes de concurrence locale (collisions de verrous `.git/index.lock` et erreurs `DiffHashMismatchError` dues aux race conditions) lorsque l'utilisateur lance plusieurs sessions de `git-commits-push` en parallèle sur la même machine.

## Philosophie et Intentions de Conception

### Pourquoi le "Passage de Commande" plutôt qu'une file d'attente classique ?
L'approche initiale consistait à mettre le processus de la Session 2 "en pause" (polling) jusqu'à ce que la Session 1 termine (modèle de la file d'attente).
Cette idée a été remplacée par un concept beaucoup plus élégant proposé par l'utilisateur : **Le Passage de Commande ("Order")**.

Puisque le skill `git-commits-push` possède une phase de découverte (Discovery) automatique, il n'a besoin d'aucun contexte initial pour savoir quoi faire : il lui suffit de scanner les dépôts pour trouver le travail en attente.

**Le Mécanisme retenu :**
L'analogie est celle d'un client au restaurant : au lieu de faire la queue bêtement, le client (Session B) voit que le chef (Session A) est occupé. Il se contente de poser un ticket de commande (`relaunch.order`) sur le comptoir et **s'éteint instantanément** (il rentre chez lui). 
L'utilisateur récupère son terminal immédiatement, sans processus fantôme qui consomme du CPU ou qui bloque un Pipe UNIX.
Quand le chef (Session A) a fini tout son travail, juste avant de fermer, il vérifie le comptoir. S'il voit un ticket de commande, il le détruit et déclenche une **nouvelle exécution fraîche** de `git-commits-push` en tâche de fond pour honorer la commande.

### Les Rejets Techniques Documentés

**1. Pourquoi pas un "PID Lock" OS ?**
Turnlock est une machine à états qui s'arrête (self-terminate) intentionnellement à chaque délégation vers un LLM. Le processus Node.js meurt et ressuscite. Un verrou PID serait caduc dès la première délégation.

**2. Pourquoi pas un `await sleep(1000)` (Polling) dans le script ?**
Bloquer le script de l'orchestrateur garde le pipeline Node (`orchestrator | bridge`) artificiellement ouvert pour rien, gaspillant des ressources et bloquant le terminal de l'utilisateur.

**3. Pourquoi pas réveiller magiquement la Session B ?**
Une fois que le pipeline Node (`orchestrator | bridge`) est mort, il n'y a plus aucun Agent ou LLM-bridge à l'écoute à l'autre bout du terminal de la Session B. Si A ressuscitait silencieusement l'orchestrateur B, ses appels au LLM partiraient dans le vide. La seule solution propre est de relancer la **commande complète** depuis la Session A.
