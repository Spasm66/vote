# Vote AG

Vote en ligne réservé aux personnes présentes, avec des codes papier à usage unique.
Aucune installation de bibliothèque : il suffit de Node.js.

## 1. Installation (une seule fois)

Dans un terminal Windows (PowerShell) :

```
winget install OpenJS.NodeJS.LTS
winget install --id Cloudflare.cloudflared
```

Fermez puis rouvrez le terminal après l'installation.

## 2. Lancer le serveur

- **Pour tester seul sur le PC** : double-cliquez sur `demarrer.bat`.
- **Pour l'AG (accessible depuis les téléphones)** : double-cliquez sur `demarrer-avec-tunnel.bat`.

La page d'administration s'ouvre toute seule (`http://localhost:3000/admin`).
Le **mot de passe admin** s'affiche dans la fenêtre noire (ex. `K7P2-XM9Q-H4TR-WB3N`, tirets facultatifs).
Il est **tiré au hasard à chaque lancement** et n'est enregistré nulle part : le serveur ne garde
qu'une empreinte hachée (scrypt) pour le vérifier. Après 10 essais ratés, l'accès est bloqué 10 minutes.

Laissez la fenêtre noire ouverte pendant toute l'AG. Si vous relancez le serveur, il faut se
reconnecter à l'admin **et** recharger l'écran de projection avec le nouveau mot de passe
(les votes déjà faits sont conservés).

## 3. Préparer l'AG

1. **Créer un groupe** (ex. « AG du 12 novembre »).
2. **Générer des codes** : prévoyez un peu plus que le nombre de présents attendu.
   Vous pouvez en générer d'autres plus tard (nouveau lot) si besoin.
3. **Imprimer le PDF** : 312 codes par page A4, en police 12, avec des pointillés pour découper.
   Gardez aussi la « liste en texte » comme sauvegarde.
4. Préparez vos questions avec « Enregistrer pour plus tard ».

## 4. Pendant l'AG

1. À l'émargement, chaque personne **pioche un papier au hasard** dans une boîte
   (deux papiers pour une procuration). Ne notez jamais qui a pris quel code : c'est ce qui rend le vote anonyme.
2. Ouvrez **l'écran de projection** (bouton dans le groupe) sur le vidéoprojecteur, touche **F** pour le plein écran.
   Il affiche le QR code, puis la question en cours, puis les résultats.
   Le bouton « QR code seul » remet le grand QR code à l'écran.
3. Les gens scannent, tapent leur code une fois. Ensuite, chaque nouvelle question apparaît toute seule sur leur téléphone.
4. **Lancer** un vote → les gens votent → **Clôturer** → les résultats s'affichent à l'écran.
   Un seul vote peut être ouvert à la fois. Le même code sert pour toutes les questions, une fois par question.
5. Si quelqu'un part ou perd son code : « Désactiver » ce code.
6. À la clôture, les résultats s'affichent aussi sur les téléphones, jusqu'au lancement de la question suivante.
   Pour ne pas les montrer, décochez « Afficher les résultats sur les téléphones » dans le groupe.
   C'est léger pour le réseau : tant que rien ne change, les téléphones reçoivent une réponse vide,
   et les résultats ne sont envoyés qu'une fois par téléphone.

## 5. Le lien public : deux options

**Option A — Tunnel rapide (gratuit, sans compte)** : c'est ce que fait `demarrer-avec-tunnel.bat`.
L'adresse (`https://…trycloudflare.com`) **change à chaque lancement**, mais le lien et le QR code dans l'admin
se mettent à jour tout seuls. Ce n'est pas grave : le QR code est projeté, il n'est pas sur les papiers.
Limite : 200 requêtes simultanées. Les téléphones réessaient tout seuls en cas de saturation, et le test de charge
ci-dessous permet de vérifier que ça tient.
Si le tunnel se coupe pendant l'AG, relancez le fichier : la nouvelle adresse s'affiche, re-projetez le QR code.
Les votes déjà faits sont conservés.

**Option B — Tunnel nommé (adresse fixe, sans limite)** : il faut un compte Cloudflare gratuit et un nom de domaine.

```
cloudflared tunnel login
cloudflared tunnel create vote
cloudflared tunnel route dns vote vote.monsite.fr
cloudflared tunnel run --url http://localhost:3000 vote
```

Puis dans l'admin, page d'accueil, renseignez l'adresse publique `https://vote.monsite.fr`.
Lancez alors `demarrer.bat` (sans tunnel rapide) et la commande `cloudflared tunnel run` dans une autre fenêtre.

## 6. Tester avant le jour J

Depuis le Wi-Fi de la fac, serveur et tunnel lancés, dans un autre terminal ouvert dans le dossier :

```
node test-charge.js https://votre-adresse.trycloudflare.com 800 MOT-DE-PASSE-ADMIN
```

Le test crée un groupe temporaire, simule 800 personnes qui votent en même temps, vérifie le décompte
et le refus du double vote, puis supprime le groupe. Testez aussi avec deux ou trois vrais téléphones.

## 7. Le jour J : check-list

- PC **branché sur secteur**, mise en veille désactivée (le fichier tunnel le fait), mises à jour Windows reportées.
- Si possible, PC relié **en câble Ethernet**.
- Dites aux gens qu'ils peuvent utiliser la **4G** si le Wi-Fi sature.
- Faites un vote d'essai au début de l'AG (« Vous m'entendez bien ? Oui / Non »).

## Anonymat et sauvegarde

- Le serveur enregistre seulement « tel code a voté à telle question » et les totaux.
  Il ne garde **jamais** le choix d'un code.
- Tout est sauvegardé dans `donnees/votes.json` : un redémarrage ou un plantage ne perd rien.
- Pour repartir de zéro : supprimez le dossier `donnees`.
