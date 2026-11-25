// ─── Legal document defaults (French) ───────────────────────────────────────
// Complete French translations of the four master documents in ./defaults-*.ts
// Keyed by docType; merged by ./index.ts (titleFr / contentFr).

export interface LegalDocDefaultFr {
  title: string
  content: string
}

export const legalDefaultsFr: Record<string, LegalDocDefaultFr> = {
  AGREEMENT_CUSTOMER: {
    title: 'Contrat Client Blasti (Conditions d’utilisation)',
    content: `Le présent Contrat Client Blasti (« le Contrat ») est un contrat contraignant conclu entre vous (« vous », « le Client ») et l’exploitant de la plateforme Blasti (« Blasti », « nous », « l’Exploitant »). Il régit votre utilisation du site web Blasti, de l’application mobile et de tout service connexe (ensemble, « la Plateforme »). En créant un compte, en cochant la case de consentement lors de l’inscription ou en utilisant de toute autre manière la Plateforme, vous acceptez le présent Contrat ainsi que la Politique de confidentialité Blasti.

Le présent Contrat est rédigé conformément aux lois de la République algérienne démocratique et populaire, en particulier la loi n° 18-07 du 10 juin 2018 relative à la protection des personnes physiques dans le traitement des données à caractère personnel, la loi n° 18-05 du 10 mai 2018 relative au commerce électronique, la loi n° 09-03 du 25 février 2009 relative à la protection du consommateur et à la répression des fraudes, ainsi que la loi n° 15-04 du 1er février 2015 fixant les règles générales applicables à la signature et à la certification électroniques.

1. DÉFINITIONS
- « Plateforme » : le service logiciel Blasti (applications web, mobiles et sur appareils) qui permet aux Clients d’obtenir des tickets numérotés de file d’attente, de faire des réservations et de suivre leur tour auprès des Agences qui utilisent Blasti.
- « Agence » : toute entreprise ou institution (clinique, administration, agence bancaire et toute autre catégorie) qui utilise la Plateforme pour gérer ses files d’attente et servir ses clients.
- « Ticket » ou « Réservation » : une place numérotée dans la file d’attente d’une Agence, obtenue par le biais de la Plateforme.
- « Compte » : votre profil d’utilisateur enregistré sur la Plateforme.

2. ÉLIGIBILITÉ ET INSCRIPTION
2.1. Vous devez disposer de la capacité juridique de contracter au sens du Code civil algérien. Les mineurs ne peuvent utiliser la Plateforme qu’avec la participation et le consentement d’un parent ou d’un représentant légal, dont le consentement au traitement des données à caractère personnel est exigé en application de la loi n° 18-07.
2.2. L’inscription requiert des informations exactes et sincères : nom et prénoms complets, adresse électronique valide, numéro de mobile algérien valide et, lorsqu’il est demandé, votre wilaya et votre commune. La fourniture de données d’identité fausses peut entraîner la suspension de votre Compte.
2.3. Une même personne ne peut détenir qu’un seul compte. Vous êtes responsable de l’activité effectuée par le biais de votre Compte ainsi que de la confidentialité de vos identifiants.

3. NATURE DE LA PLATEFORME — INTERMÉDIAIRE TECHNIQUE
3.1. Blasti fournit un outil technique de gestion des files d’attente. Blasti n’est pas le fournisseur des services rendus par les Agences (consultation médicale, opérations bancaires, démarches administratives, etc.) : le contrat relatif au service de l’Agence se forme directement et exclusivement entre vous et l’Agence.
3.2. Blasti n’intervient pas dans le contenu, la qualité, le prix, l’organisation ni le résultat des services fournis par les Agences, et ne formule à leur égard aucune déclaration ni garantie. Les obligations commerciales, de protection du consommateur et de responsabilité professionnelle relatives au service de l’Agence incombent à la seule Agence, en application de la loi n° 09-03 et des règles professionnelles applicables.
3.3. Les informations affichées relatives à une Agence (horaires, adresse, services, tarifs le cas échéant) sont fournies par cette Agence, laquelle demeure responsable de leur exactitude.

4. TICKETS, RÉSERVATIONS ET DÉFAUTS DE PRÉSENTATION
4.1. Lorsque vous prenez un Ticket ou une Réservation par le biais de la Plateforme, une place dans la file d’attente vous est réservée auprès de l’Agence, selon sa configuration.
4.2. Vous devez vous présenter en temps utile avant votre tour. Le défaut répété de présentation après la prise de tickets (« no-show ») peut, conformément à la politique publiée par l’Agence, amener celle-ci à restreindre votre possibilité de prendre d’autres tickets par le biais de la Plateforme.
4.3. Annulation : vous pouvez annuler un Ticket ou une Réservation depuis la Plateforme avant son appel, lorsque cette fonctionnalité est activée par l’Agence.
4.4. L’ordre de passage et le temps d’attente estimé constituent des estimations produites par la Plateforme à titre purement indicatif ; les délais réels de service dépendent de l’Agence.

5. PAIEMENTS
5.1. Lorsqu’une Agence active des services payants par le biais de la Plateforme, les prix sont affichés en dinar algérien (DZD), taxes applicables incluses lorsque cela est requis. Le paiement est encaissé par voie électronique par l’intermédiaire de prestataires de paiement algériens certifiés (par exemple CIB / EDAHABIA via la passerelle Chargily).
5.2. Blasti ne stocke pas les données de votre carte bancaire. Les données de la carte sont traitées par le prestataire de paiement certifié, aux termes de ses propres obligations de sécurité.
5.3. Les remboursements et l’exercice des droits du consommateur relatifs à un service payant d’une Agence sont traités avec l’Agence, conformément à la loi n° 09-03 et à la loi n° 18-05 ; Blasti apporte une assistance technique en transmettant l’instruction de remboursement au prestataire de paiement, le cas échéant.
5.4. Lorsqu’une offre payante est conclue à distance au sens de la loi n° 18-05 relative au commerce électronique, le droit de rétractation statutaire applicable aux contrats de vente à distance (loi n° 18-05 et loi n° 09-03) s’exerce auprès du fournisseur du service concerné : l’Agence pour ses propres services, Blasti pour les abonnements à la Plateforme dans les conditions publiées sur celle-ci. L’exercice du droit de rétractation, lorsqu’il s’applique, suit les conditions et délais légaux en vigueur en Algérie.

6. COMMUNICATIONS ÉLECTRONIQUES
6.1. Vous consentez à recevoir des notifications de service (SMS, WhatsApp, courrier électronique ou notifications push) relatives à vos tickets, vos réservations et votre Compte, y compris les avis de sécurité nécessaires.
6.2. En application de la loi n° 18-05 relative au commerce électronique et de la loi n° 15-04 relative à la signature et à la certification électroniques, les documents, accords et notifications électroniques échangés par le biais de la Plateforme ont la même valeur probante que les documents papier ; un accord conclu ou accepté par voie électronique ne peut être contesté au seul motif qu’il se présente sous forme électronique.
6.3. Les communications à caractère commercial ne sont adressées qu’avec votre consentement distinct, que vous pouvez retirer à tout moment depuis les paramètres de votre profil.

7. DONNÉES À CARACTÈRE PERSONNEL ET CONFIDENTIALITÉ
7.1. Vos données à caractère personnel sont traitées conformément à la Politique de confidentialité Blasti, qui fait partie intégrante du présent Contrat, et conformément à la loi n° 18-07.
7.2. Lors de l’inscription, vous donnez un consentement libre, spécifique et éclairé au traitement de vos données aux fins décrites dans la Politique de confidentialité. Votre consentement est enregistré (document, version, date) afin de pouvoir être démontré. Vous pouvez retirer votre consentement et exercer vos droits comme décrit dans la Politique de confidentialité.
7.3. Les données relatives à vos tickets peuvent être présentées à l’Agence que vous visitez afin que vous puissiez être servi ; les écrans d’affichage des files d’attente dans les Agences montrent les numéros de tickets et, selon la configuration établie par l’Agence, des informations de service limitées.

8. UTILISATION ACCEPTABLE
Vous vous engagez à NE PAS : (a) créer des comptes sous une fausse identité ou aux fins de réservation massive automatisée ; (b) prendre des tickets que vous n’avez pas l’intention d’honorer, de manière à perturber la file d’attente de l’Agence ; (c) revendre, transférer ou monétiser des places dans les files d’attente ; (d) tenter de contourner l’ordre de la file d’attente, la numérotation des tickets ou les vérifications des appareils ; (e) sonder, scanner ou attaquer l’infrastructure technique de la Plateforme, ou y introduire du code malveillant ; (f) utiliser la Plateforme d’une manière contraire à la loi algérienne, à l’ordre public ou aux bonnes mœurs.

9. PROPRIÉTÉ INTELLECTUELLE
La Plateforme, ses logiciels, sa marque, ses logos, ses interfaces et son contenu sont protégés par le droit d’auteur et les droits voisins. Blasti vous concède une licence personnelle, non exclusive, non transférable et révocable d’utilisation de la Plateforme à vos fins personnelles non commerciales. Toute autre utilisation, reproduction ou exploitation sans autorisation écrite préalable est interdite.

10. DISPONIBILITÉ
Blasti s’efforce de maintenir la Plateforme disponible et de corriger les défaillances dans un délai raisonnable. Toutefois, la Plateforme est fournie sur la base d’une obligation de moyens : des interruptions (maintenance, réseau, électricité, télécommunications) peuvent survenir, et Blasti peut suspendre l’accès à des fins de maintenance ou pour de graves raisons de sécurité, en vous en informant dans la mesure du possible.

11. LIMITATION DE RESPONSABILITÉ
11.1. Dans la mesure maximale permise par le Code civil algérien, la responsabilité de Blasti pour tout dommage lié à la Plateforme est limitée au dommage direct, personnel et certain, et exclut le dommage indirect, la perte de données non imputable à une faute de Blasti, la perte de chance ou le préjudice commercial.
11.2. Blasti n’est pas responsable des actes ou omissions des Agences, ni de l’exécution, de la qualité ou de l’annulation des services de l’Agence.
11.3. Aucune stipulation du présent Contrat n’exclut la responsabilité qui ne peut légalement être exclue, y compris la responsabilité en cas de mort ou de blessures corporelles causées par une faute, ou la responsabilité à l’égard des consommateurs qui est impérative en application de la loi n° 09-03.

12. FORCE MAJEURE
Aucune des parties n’est responsable de l’inexécution causée par un cas de force majeure au sens du Code civil algérien, y compris les catastrophes naturelles, les décisions des autorités publiques, les défaillances du réseau ou des télécommunications et les coupures de courant.

13. SUSPENSION ET RÉSILIATION
13.1. Vous pouvez cesser d’utiliser la Plateforme et demander la suppression de votre Compte à tout moment depuis votre profil ou en contactant l’assistance.
13.2. Blasti peut suspendre ou clôturer un Compte qui méconnaît le présent Contrat, qui est utilisé à des fins de fraude ou qui crée un risque pour la sécurité, après notification dans la mesure du possible. Les stipulations qui, par leur nature, survivent à la résiliation (protection des données, responsabilité, droit applicable) demeurent en vigueur.

14. MODIFICATIONS DU PRÉSENT CONTRAT
Blasti peut modifier le présent Contrat. Les changements substantiels sont notifiés dans la Plateforme avant leur entrée en vigueur. La poursuite de l’utilisation de la Plateforme après la date d’entrée en vigueur d’une nouvelle version vaut acceptation. Si vous n’acceptez pas une modification, vous devez cesser d’utiliser la Plateforme et pouvez demander la suppression de votre Compte.

15. DROIT APPLICABLE ET JURIDICTIONS COMPÉTENTES
Le présent Contrat est régi par le droit algérien. Tout litige relatif à la Plateforme est préalablement soumis à une tentative de règlement amiable ; à défaut de règlement, les juridictions algériennes compétentes sont saisies, sans préjudice des règles de compétence en matière de consommation prévues par la loi n° 09-03.

16. CONTACT
Pour toute question relative au présent Contrat ou pour exercer vos droits : par le biais de la section d’assistance intégrée à l’application, ou à l’adresse d’assistance publiée sur blastidz.online. Les réclamations relatives aux données à caractère personnel peuvent également être adressées à l’Autorité nationale de protection des données à caractère personnel (ANPDP).`,
  },
  AGREEMENT_AGENCY_OWNER: {
    title: 'Contrat du propriétaire de l’Agence Blasti (Conditions de service professionnelles)',
    content: `Le présent Contrat du propriétaire de l’Agence Blasti (« le Contrat ») est un contrat contraignant conclu entre l’entreprise ou l’institution qui s’inscrit en qualité de propriétaire d’un compte d’Agence (« vous », « le propriétaire de l’Agence », « l’Agence ») et l’exploitant de la plateforme Blasti (« Blasti », « nous », « l’Exploitant »). Il régit votre utilisation de la Plateforme Blasti pour gérer les files d’attente, les tickets, les succursales, le personnel, les appareils (bornes libre-service, écrans d’affichage, imprimantes) et les relations avec la clientèle (ensemble, « les Services »). En créant une Agence, en cochant la case de consentement ou en utilisant les Services, vous acceptez le présent Contrat ainsi que la Politique de confidentialité Blasti.

Le présent Contrat est régi par les lois de la République algérienne démocratique et populaire, en particulier la loi n° 18-07 du 10 juin 2018 relative à la protection des personnes physiques dans le traitement des données à caractère personnel, la loi n° 18-05 du 10 mai 2018 relative au commerce électronique, la loi n° 09-03 du 25 février 2009 relative à la protection du consommateur et à la répression des fraudes, la loi n° 15-04 du 1er février 2015 fixant les règles générales applicables à la signature et à la certification électroniques, le Code civil (ordonnance n° 75-58) et le Code de commerce (ordonnance n° 75-59).

1. DÉFINITIONS
- « Plateforme » : le service logiciel Blasti (applications web, de bureau et sur appareils) de gestion des files d’attente et des tickets.
- « Compte d’Agence » : l’espace de travail que vous administrez sur la Plateforme, comprenant les succursales, les services, les sous-comptes du personnel et les appareils connectés.
- « Compte du personnel » : un sous-compte que vous créez pour vos employés afin qu’ils utilisent les Services en votre nom.
- « Client » : toute personne physique qui prend un Ticket ou une Réservation auprès de votre Agence par le biais de la Plateforme.

2. ÉLIGIBILITÉ ET INSCRIPTION
2.1. Vous déclarez et garantissez que vous êtes une entreprise ou une institution légalement constituée et enregistrée en Algérie et, le cas échéant, immatriculée au registre de commerce (RC), titulaire d’un numéro d’identification fiscale (NIF) et, le cas échéant, d’un numéro d’identification sociale (NIS), et que vous êtes dûment autorisé à accepter le présent Contrat au nom de l’Agence.
2.2. Les informations communiquées lors de l’inscription (identité, coordonnées, adresse, wilaya, code d’Agence) doivent être exactes et tenues à jour. Blasti peut demander des pièces justificatives afin de vérifier l’identité de l’Agence, en application de ses obligations de sécurité.
2.3. Le code d’Agence (code personnalisé) réservé sur la Plateforme constitue un identifiant technique et non un droit de marque ; il ne doit pas porter atteinte aux droits de tiers.

3. LES SERVICES
Blasti met à la disposition de l’Agence des outils comprenant notamment : la gestion des files d’attente et des guichets, la délivrance de tickets, les réservations, les écrans d’affichage (écrans TV), les bornes libre-service, l’appel des files d’attente, les notifications aux Clients, les tableaux de bord d’analyse, l’administration du personnel et des succursales, ainsi que les paiements électroniques en option. Les Services évoluent au fil du temps ; les changements fonctionnels qui ne réduisent pas les fonctionnalités essentielles ne nécessitent pas de modification du présent Contrat.

4. ADMINISTRATION DU COMPTE ET RESPONSABILITÉ À L’ÉGARD DES COMPTES DU PERSONNEL
4.1. En qualité de propriétaire de l’Agence, vous êtes l’administrateur du compte d’Agence. Vous êtes responsable : de la création des Comptes du personnel ainsi que de leurs rôles, permissions et comportements ; de l’exactitude des données qu’ils saisissent ; et de la conformité de leur utilisation de la Plateforme au présent Contrat.
4.2. Les Comptes du personnel ne peuvent être créés que pour des personnes qui sont vos employés ou vos représentants autorisés. Vous devez veiller, avant la création ou au moment de celle-ci, à ce que chaque membre du personnel soit informé du Contrat utilisateur du personnel Blasti applicable et de la Politique de confidentialité, et les accepte ; la Plateforme enregistre le consentement manifesté lors de la création.
4.3. Vous demeurez pleinement responsable, envers Blasti et envers les tiers, des actions effectuées par le biais des Comptes du personnel, dans les limites du Code civil algérien.

5. EXACTITUDE DU PROFIL DE L’AGENCE ET OBLIGATIONS D’INFORMATION
5.1. Le profil publié à l’attention des Clients (dénomination, catégorie, adresse, numéros de contact, horaires d’ouverture, services et toute information tarifaire) doit être sincère, actualisé et non trompeur, en application de la loi n° 09-03 (interdiction des pratiques trompeuses) et, lorsque vous vendez en ligne, des obligations d’information précontractuelle prévues par la loi n° 18-05 relative au commerce électronique.
5.2. Lorsque vous vendez des services par le biais de la Plateforme, vous êtes le « fournisseur » au sens de la loi n° 18-05 relative au commerce électronique et devez respecter les obligations qui en découlent à l’égard des consommateurs (information, processus de commande, affichage des prix en DZD, conformité, rétractation le cas échéant). Blasti constitue un moyen technique d’affichage et de paiement, et non le fournisseur.

6. ABONNEMENTS, FACTURATION ET FISCALITÉ
6.1. L’accès aux Services est fourni conformément à la formule d’abonnement choisie par l’Agence (offre FREE ou offres payantes), sous réserve de ses limites (sièges du personnel, succursales, fonctionnalités). Les abonnements payants sont facturés en dinar algérien (DZD) pour la période choisie.
6.2. Le paiement s’effectue par voie électronique par l’intermédiaire de prestataires de paiement algériens certifiés (par exemple CIB / EDAHABIA via la passerelle Chargily). Blasti ne stocke pas les données de votre carte.
6.3. Les abonnements se renouvellent à l’expiration de chaque période, sauf résiliation avant le renouvellement. Les remboursements des périodes non utilisées après renouvellement suivent la politique de remboursement publiée sur la Plateforme ainsi que les règles de la loi n° 18-05 relatives au commerce électronique.
6.4. Vous êtes responsable de vos propres obligations fiscales, comptables et sociales (TVA et tous autres droits applicables) ; les prix sur la Plateforme sont affichés toutes taxes incluses ou hors taxes selon ce qui est indiqué au moment de l’achat.

7. APPAREILS ET RÉSEAU LOCAL
7.1. Lorsque vous connectez des appareils aux Services (ordinateurs Windows, bornes, écrans TV, imprimantes, smartphones), vous êtes responsable de leur sécurité physique, de la mise à jour de leur système d’exploitation, de la configuration de votre réseau local et de la garde des identifiants d’appariement et des jetons d’appareil.
7.2. L’appariement d’un appareil établit un lien sécurisé entre l’appareil et votre compte d’Agence. Un appareil vendu, perdu ou retiré du service doit être dissocié du compte d’Agence par vos soins ; vous demeurez responsable de l’activité effectuée par le biais d’appareils dissociés dont l’autorisation n’a pas été révoquée.
7.3. L’application de bureau exploite un service local sur votre réseau afin d’assurer la continuité hors ligne ; vous devez la maintenir isolée de l’internet public conformément aux recommandations de configuration fournies par Blasti.

8. DONNÉES À CARACTÈRE PERSONNEL DES CLIENTS
8.1. Dans le cadre des traitements réalisés sur la Plateforme, Blasti agit en qualité de responsable du traitement pour les données de compte, d’abonnement et de sécurité du propriétaire de l’Agence et des Comptes du personnel, et fournit l’environnement technique de traitement pour les données des Clients qui prennent des tickets auprès de votre Agence.
8.2. Vous êtes, de manière distincte, responsable — en qualité de responsable du traitement de vos propres traitements — de la conformité de votre utilisation des données des Clients à la loi n° 18-07 : information des Clients, traitement des données uniquement aux fins de leur prise en charge, honneur de leurs demandes (accès, rectification, opposition), sécurisation des données, accomplissement auprès de l’Autorité nationale de protection des données à caractère personnel (ANPDP) des formalités de déclaration ou d’autorisation que vos traitements exigent, et saisine de l’ANPDP lorsque cela est requis.
8.3. Vous ne devez pas exporter, conserver au-delà du nécessaire ni réutiliser les données des Clients collectées par le biais de la Plateforme à des fins étrangères à la relation Agence-client (en particulier, à des fins de prospection commerciale massive non sollicitée, en violation de la loi n° 18-05 et de la loi n° 09-03).
8.4. La Plateforme affiche des informations de file d’attente sur les écrans de vos locaux (numéros de tickets, noms des services et, selon la configuration, des références clients limitées). Vous êtes responsable de la conformité de cet affichage à la loi n° 18-07 et de l’absence de divulgation excessive de données à caractère personnel.

9. UTILISATION ACCEPTABLE ET INTÉGRITÉ DE LA PLATEFORME
Vous vous engagez à NE PAS : (a) utiliser les Services à des fins illicites ou contraires à l’ordre public ; (b) manipuler des évaluations ou des avis (astroturfing), pratique également interdite en application de la loi n° 09-03 ; (c) interférer avec les files d’attente ou les données d’autres Agences ; (d) procéder à une ingénierie inverse, revendre les Services ou les fournir à des tiers en qualité de prestataire de services, sans convention écrite ; (e) surcharger, sonder ou attaquer l’infrastructure de la Plateforme ; (f) adresser aux Clients des communications illicites par le biais des canaux de la Plateforme.

10. NIVEAUX DE SERVICE ET ASSISTANCE
10.1. Blasti s’efforce de maintenir la Plateforme en nuage disponible 24 heures sur 24 et 7 jours sur 7, et les applications de bureau fonctionnelles hors ligne grâce au service local ; les Services sont fournis sur la base d’une obligation de moyens, sans garantie contractuelle de disponibilité, sauf souscription écrite d’un engagement spécifique de niveau de service.
10.2. L’assistance est assurée par les canaux officiels publiés sur la Plateforme.

11. PROPRIÉTÉ INTELLECTUELLE
11.1. La Plateforme, ses logiciels, sa marque, ses logos, ses interfaces et sa documentation constituent des biens protégés. Blasti concède à l’Agence une licence non exclusive et non transférable, limitée dans le temps à la durée de l’abonnement, d’utilisation des Services pour l’activité propre de l’Agence.
11.2. L’Agence conserve l’ensemble des droits sur son propre contenu (dénomination, logo, descriptions, services) et concède à Blasti la licence strictement nécessaire à l’hébergement et à l’affichage de ce contenu sur la Plateforme, à la demande de l’Agence.

12. CONFIDENTIALITÉ
Chaque partie garde secrètes les informations confidentielles de l’autre partie (y compris la documentation technique, les tarifs et les données non publiques) et ne les utilise que pour l’exécution du présent Contrat, pendant la durée de celui-ci et après son terme.

13. DÉCLARATIONS, GARANTIES ET INDEMNISATION
13.1. Blasti déclare qu’elle exécutera les Services avec le soin professionnel requis. Sauf stipulation expresse contraire, les Services sont fournis en l’état, et Blasti n’accorde aucune autre garantie, expresse ou implicite.
13.2. Vous garantissez Blasti contre les réclamations de tiers (y compris les Clients, les employés et les autorités) nées de votre utilisation des Services, du contenu de votre profil, des services que vous vendez ou de votre traitement des données des Clients, dans les limites du Code civil algérien.

14. LIMITATION DE RESPONSABILITÉ
14.1. La responsabilité totale de Blasti au titre de l’ensemble des réclamations liées aux Services est limitée, par année d’abonnement, aux montants effectivement payés par l’Agence à Blasti au cours de cette année, sauf en cas de faute intentionnelle ou de négligence grave.
14.2. Blasti n’est pas responsable des dommages indirects : perte de chiffre d’affaires, perte de Clients, préjudice commercial ou conséquences des décisions d’exploitation propres de l’Agence.

15. SUSPENSION ET RÉSILIATION
15.1. Chaque partie peut résilier l’abonnement à son échéance. Blasti peut suspendre les Services en cas de non-paiement d’une facture échue (après mise en demeure), en cas de manquement grave au présent Contrat, ou pour des motifs légaux ou de sécurité.
15.2. En cas de résiliation, l’Agence peut exporter ses données opérationnelles essentielles par le biais des fonctions d’exportation de la Plateforme pendant une durée de trente (30) jours, au terme de laquelle Blasti peut supprimer les données de l’Agence conformément à son calendrier de conservation, à l’exception des documents que la loi exige de conserver.

16. FORCE MAJEURE
Aucune des parties n’est responsable d’une défaillance causée par un cas de force majeure au sens du Code civil algérien (catastrophes naturelles, décisions des autorités publiques, défaillances de réseau, d’énergie ou de télécommunications).

17. MODIFICATIONS DU PRÉSENT CONTRAT
Blasti peut modifier le présent Contrat. Les changements substantiels sont notifiés avant leur entrée en vigueur ; la poursuite de l’abonnement après la date d’entrée en vigueur vaut acceptation. Si vous n’acceptez pas les modifications, vous pouvez résilier à l’expiration de la période en cours.

18. DROIT APPLICABLE ET JURIDICTIONS COMPÉTENTES
Le présent Contrat est régi par le droit algérien. Les litiges font en premier lieu l’objet d’une tentative de règlement amiable ; à défaut de règlement, les juridictions algériennes compétentes sont saisies.

19. CONTACT
Assistance Blasti : par les canaux officiels publiés sur blastidz.online. Les réclamations relatives aux données à caractère personnel peuvent être adressées à l’Autorité nationale de protection des données à caractère personnel (ANPDP).`,
  },
  AGREEMENT_STAFF: {
    title: 'Contrat utilisateur du personnel Blasti',
    content: `Le présent Contrat utilisateur du personnel Blasti (« le Contrat ») régit l’utilisation d’un sous-compte du personnel sur la plateforme Blasti (« la Plateforme ») par l’employé ou le représentant autorisé pour lequel il a été créé (« vous », « l’utilisateur du personnel »). Il est conclu entre vous et l’exploitant de la Plateforme (« Blasti », « nous », « l’Exploitant »). Du fait de la création d’un compte du personnel et du cochage de la case de consentement présentée lors de cette création, ou de la première utilisation du compte du personnel, vous acceptez le présent Contrat ainsi que la Politique de confidentialité Blasti.

Le présent Contrat est régi par les lois de la République algérienne démocratique et populaire, en particulier la loi n° 18-07 du 10 juin 2018 relative à la protection des personnes physiques dans le traitement des données à caractère personnel, la loi n° 18-05 du 10 mai 2018 relative au commerce électronique (votre acceptation électronique du présent Contrat forme un contrat électronique de même valeur probante qu’un contrat papier), la loi n° 15-04 du 1er février 2015 fixant les règles générales applicables à la signature et à la certification électroniques, ainsi que le Code civil (ordonnance n° 75-58).

1. DÉFINITIONS
- « Plateforme » : le service logiciel Blasti (applications web, de bureau et sur appareils).
- « Agence » : l’entreprise dont relève le compte auquel votre sous-compte du personnel est rattaché ; son propriétaire est le « propriétaire de l’Agence ».
- « Compte du personnel » : le sous-compte créé pour vous afin de servir les clients, de gérer les guichets et les files d’attente, et d’utiliser les fonctionnalités que le propriétaire de l’Agence vous accorde.

2. CRÉATION ET ADMINISTRATION DU COMPTE
2.1. Votre compte du personnel est créé par le propriétaire de l’Agence (ou, exceptionnellement, par l’administration de la plateforme). Blasti ne décide pas de l’attribution d’un compte du personnel ; les accès, rôles et permissions sont choisis par le propriétaire de l’Agence.
2.2. Votre compte est personnel. Vous ne devez partager votre nom d’utilisateur, votre mot de passe ni vos codes à usage unique avec quiconque. Toute activité effectuée par le biais de votre compte est présumée être la vôtre, sauf si vous signalez une compromission sans délai injustifié.
2.3. Vous devez utiliser un mot de passe robuste et signaler immédiatement au propriétaire de l’Agence et à l’assistance Blasti toute compromission suspectée de vos identifiants.

3. RELATION AVEC L’AGENCE — ABSENCE DE CONTRAT DE TRAVAIL
3.1. Le présent Contrat concerne uniquement le compte logiciel. Il ne crée, ne modifie ni ne remplace aucun contrat de travail ni aucune relation de prestation de services entre vous et l’Agence, lesquels demeurent régis par le droit algérien du travail (loi n° 90-11 du 21 avril 1990 relative aux relations de travail), par votre contrat et par le règlement intérieur de l’Agence.
3.2. Blasti n’est pas partie à votre relation de travail et ne gère ni votre rémunération, ni vos horaires de travail, ni vos congés, ni la discipline ; elle fournit uniquement l’outil technique utilisé dans le cadre de cette relation.

4. UTILISATION DU COMPTE DU PERSONNEL
4.1. Vous utilisez la Plateforme pour servir les clients de l’Agence : appel et prise en charge des tickets, gestion des guichets, consultation des files d’attente et des statistiques, ainsi que les autres fonctions que le propriétaire de l’Agence vous accorde.
4.2. Vous devez utiliser la Plateforme avec diligence, de manière loyale et uniquement dans le cadre des permissions qui vous sont accordées. Vous ne devez pas tenter d’accéder à des données ou à des fonctions au-delà de votre rôle (autres succursales, autres Agences, données d’autres utilisateurs, fonctions administratives).
4.3. Vous ne devez pas utiliser la Plateforme à des fins personnelles étrangères à votre travail, ni au détriment des clients ou de l’Agence.

5. CONFIDENTIALITÉ ET DONNÉES À CARACTÈRE PERSONNEL
5.1. Par le biais du compte du personnel, vous aurez accès à des données à caractère personnel de clients (noms, coordonnées, tickets, historiques) ainsi qu’à celles de l’Agence. Vous devez garder toutes ces données confidentielles, ne les utiliser que pour l’accomplissement de vos tâches pour le compte de l’Agence, et ne jamais les divulguer, les copier ni les réutiliser hors de la Plateforme à toute autre fin. Cette obligation se poursuit après la désactivation de votre compte.
5.2. Votre traitement des données des clients par le biais de la Plateforme doit être conforme à la loi n° 18-07 : limitation des finalités, sécurité et transmission des demandes des clients (accès, rectification, opposition) au propriétaire de l’Agence.
5.3. Blasti traite vos propres données de compte (nom, coordonnées, journaux d’activité) comme décrit dans la Politique de confidentialité, sur le fondement de votre consentement manifesté lors de la création du compte et des besoins légitimes de sécurité du service.

6. COMPORTEMENTS INTERDITS
Vous vous engagez à NE PAS : (a) divulguer vos identifiants ; (b) créer, modifier ou supprimer des données de mauvaise foi (tickets fictifs, enregistrements altérés, historiques supprimés) ; (c) harceler ou maltraiter les clients par le biais des canaux de la Plateforme ; (d) exporter les données des clients ou en faire des captures d’écran à des fins étrangères à vos tâches ; (e) porter atteinte à l’intégrité technique de la Plateforme, des appareils ou du réseau ; (f) utiliser le compte après la fin de votre relation avec l’Agence.

7. SUSPENSION, DÉSACTIVATION ET RÉSILIATION
7.1. Le propriétaire de l’Agence peut suspendre, restreindre ou désactiver votre compte du personnel à tout moment, notamment à la fin de votre relation avec l’Agence. Blasti peut désactiver un compte en cas de manquement grave au présent Contrat, de compromission suspectée ou pour des motifs légaux.
7.2. Dès la désactivation, vous perdez l’accès à la Plateforme ; les obligations de confidentialité de la section 5 survivent.

8. RESPONSABILITÉ
8.1. Vous êtes responsable, envers l’Agence et dans les limites du Code civil algérien, des dommages causés à la Plateforme ou aux données par votre faute intentionnelle ou votre négligence grave dans l’utilisation du compte du personnel.
8.2. La responsabilité de Blasti à l’égard de la Plateforme est limitée au dommage direct et aux obligations d’un fournisseur de logiciel sur la base d’une obligation de moyens ; Blasti n’est pas responsable des actes du propriétaire de l’Agence ou de l’Agence.

9. MODIFICATIONS DU PRÉSENT CONTRAT
Blasti peut modifier le présent Contrat ; les changements substantiels sont notifiés dans la Plateforme. La poursuite de l’utilisation du compte du personnel après la date d’entrée en vigueur d’une nouvelle version vaut acceptation.

10. DROIT APPLICABLE ET JURIDICTIONS COMPÉTENTES
Le présent Contrat est régi par le droit algérien. Les litiges relatifs au compte du personnel lui-même font en premier lieu l’objet d’une tentative de règlement amiable avec l’assistance Blasti ; à défaut de règlement, les juridictions algériennes compétentes sont saisies. Les litiges avec l’Agence demeurent hors du champ d’application du présent Contrat.

11. CONTACT
Assistance Blasti : par les canaux officiels publiés sur blastidz.online. Les réclamations relatives aux données à caractère personnel peuvent également être adressées à l’Autorité nationale de protection des données à caractère personnel (ANPDP).`,
  },
  PRIVACY_POLICY: {
    title: 'Politique de confidentialité Blasti',
    content: `La présente Politique de confidentialité (« la Politique ») explique comment l’exploitant de la plateforme Blasti (« Blasti », « nous », « l’Exploitant ») collecte et traite les données à caractère personnel des personnes qui utilisent le site web Blasti, l’application mobile, l’application de bureau et les appareils connectés (ensemble, « la Plateforme ») : clients, propriétaires d’Agences et utilisateurs du personnel. Elle s’applique à tous les types de comptes.

La présente Politique est rédigée conformément à la loi n° 18-07 du 10 juin 2018 relative à la protection des personnes physiques dans le traitement des données à caractère personnel, qui a institué l’Autorité nationale de protection des données à caractère personnel (« ANPDP »), ainsi qu’à la loi n° 18-05 du 10 mai 2018 relative au commerce électronique, à la loi n° 09-03 du 25 février 2009 relative à la protection du consommateur et à la répression des fraudes, à la loi n° 15-04 du 1er février 2015 fixant les règles générales applicables à la signature et à la certification électroniques et au décret présidentiel n° 20-05 du 20 janvier 2020 portant mise en place d’un dispositif national de la sécurité des systèmes d’information. Elle fait partie intégrante des contrats d’utilisation Blasti.

1. QUI EST RESPONSABLE DE VOS DONNÉES
Le responsable des traitements décrits dans la présente Politique est l’Exploitant de la Plateforme Blasti, dont l’identité et les coordonnées sont publiées dans la section d’assistance de la Plateforme et sur blastidz.online. L’Exploitant accomplit auprès de l’ANPDP les formalités de déclaration et, lorsque la loi l’exige, les demandes d’autorisation prévues par la loi n° 18-07 pour les traitements qu’il effectue en qualité de responsable. Pour les traitements qu’une Agence effectue sur les données de ses clients dans le cadre de leur prise en charge (ses dossiers, ses relations, ses services), l’Agence est le responsable du traitement et Blasti fournit l’environnement technique de traitement ; voir la section 7.

2. DONNÉES QUE NOUS COLLECTONS
Selon votre type de compte et votre utilisation de la Plateforme, nous traitons :
2.1. Données de compte et d’identité : nom d’utilisateur, nom et prénoms complets, adresse électronique, numéro de téléphone mobile, mot de passe (conservé uniquement sous la forme d’une empreinte de hachage irréversible), photo de profil, langue, wilaya et commune (lorsque vous les fournissez), ainsi que votre identifiant d’utilisateur de la plateforme.
2.2. Données de vérification : codes de vérification à usage unique envoyés par courrier électronique ou SMS/WhatsApp et leur statut de remise ; journaux des événements de vérification.
2.3. Données de tickets et de files d’attente : tickets et réservations pris auprès des Agences, service demandé, guichets, horodatages, temps d’attente et de prise en charge, annulations, indicateurs de défaut de présentation (no-show) et historique de vos visites.
2.4. Avis et évaluations que vous soumettez, et favoris que vous choisissez.
2.5. Données de paiement : pour les abonnements payants ou les services payants, identifiants de facturation et références de transaction traités par l’intermédiaire de prestataires de paiement algériens certifiés (CIB / EDAHABIA via la passerelle Chargily). Nous ne collectons ni ne stockons l’intégralité de votre numéro de carte ni vos codes secrets de carte.
2.6. Données d’appareils et données techniques : identifiants d’appareils utilisés pour l’appariement des appareils de l’Agence (bornes, ordinateurs, téléviseurs, imprimantes), version de l’application, plateforme (web/mobile/bureau), adresse IP lors des événements présentant un enjeu de sécurité, et journaux de diagnostic que vous ou votre Agence transmettez à des fins d’assistance.
2.7. Données d’Agence (pour les propriétaires d’Agences) : identité de l’Agence, informations d’immatriculation que vous saisissez, succursales, services, horaires d’ouverture et statistiques d’exploitation.
2.8. Données du personnel (pour les comptes du personnel) : nom, coordonnées, journaux d’activité et permissions accordées par le propriétaire de l’Agence.

3. FINALITÉS DES TRAITEMENTS ET BASES LÉGALES
Nous traitons vos données à caractère personnel uniquement à des finalités déterminées, explicites et légitimes :
(a) créer et sécuriser votre compte, vérifier vos coordonnées et vous authentifier — sur le fondement de votre consentement donné lors de l’inscription et de l’exécution du contrat d’utilisation ;
(b) fournir le service de gestion des files d’attente : délivrance de tickets et de réservations, suivi de votre tour, notification de l’approche de votre tour — exécution du contrat d’utilisation ;
(c) permettre aux Agences de vous servir et de gérer leurs files d’attente — exécution des contrats des deux parties ;
(d) traiter les paiements des services et abonnements payants et assurer la facturation — exécution du contrat et obligations comptables légales ;
(e) assurer la sécurité de la Plateforme, détecter la fraude et les abus, tenir des journaux d’audit et respecter les obligations légales — intérêts légitimes de sécurité et obligations légales ;
(f) envoyer des notifications de service relatives à vos tickets et à votre compte — exécution du contrat. Les communications à caractère commercial ne sont adressées qu’avec votre consentement distinct et révocable ;
(g) produire des statistiques agrégées et améliorer le service — intérêts légitimes, sur des données anonymisées ou agrégées dans la mesure du possible.

4. CONSENTEMENT
Lors de l’inscription ainsi qu’à la création des comptes du personnel et des comptes d’Agence, nous recueillons votre consentement libre, spécifique et éclairé à la présente Politique et au contrat d’utilisation applicable, au moyen d’une case de consentement obligatoire. Le fait du consentement est enregistré (document, version, date et heure, adresse IP de la requête) afin de pouvoir le démontrer comme l’exige la loi n° 18-07. Lorsqu’un traitement repose sur le consentement (par exemple le marketing), vous pouvez retirer ce consentement à tout moment, sans que cela affecte la licéité des traitements déjà effectués.

5. PARTAGE DES DONNÉES
Nous ne vendons pas vos données à caractère personnel. Nous ne les partageons qu’avec :
(a) l’Agence que vous visitez ou auprès de laquelle vous avez pris un ticket, afin qu’elle puisse vous servir (identité, ticket, historique pertinent) ;
(b) les prestataires de paiement (par exemple Chargily, émetteurs CIB / EDAHABIA) aux seules fins de traitement de vos paiements ;
(c) les prestataires de communications (SMS, WhatsApp, services d’envoi de courriers électroniques) aux seules fins de remise de vos notifications et de vos codes de vérification ;
(d) les prestataires d’hébergement et d’infrastructure exploitant les serveurs de la Plateforme ;
(e) les autorités publiques, lorsque la loi exige ou autorise la communication, sur demande légale.
Chaque destinataire ne traite les données que pour les finalités énoncées aux présentes, dans le respect d’obligations contractuelles de confidentialité et de sécurité.

6. TRANSFERTS INTERNATIONAUX
Les données à caractère personnel sont hébergées et principalement traitées sur des serveurs situés conformément à l’article 44 de la loi n° 18-07 : aucun transfert vers un pays étranger n’a lieu, sauf si ce pays assure un niveau de protection adéquat ou si le transfert est autorisé par l’Autorité nationale de protection des données à caractère personnel (ANPDP), ou si une exception prévue par la loi s’applique. Lorsque le routage technique rend un transfert transitoire inévitable (par exemple la remise de messages), celui-ci est limité au strict minimum nécessaire et protégé par des garanties appropriées.

7. AGENCES ET LEUR RESPONSABILITÉ
Lorsqu’une Agence utilise la Plateforme pour vous servir, l’Agence agit en qualité de responsable du traitement des opérations qu’elle effectue sur vos données dans le cadre de son propre établissement. Blasti lui fournit des outils techniques (gestion des files d’attente, écrans d’affichage, bornes, notifications) et exige contractuellement des Agences qu’elles respectent la loi n° 18-07, qu’elles n’utilisent vos données que pour vous servir et qu’elles honorent vos demandes. Les écrans dans les Agences affichent des informations de file d’attente (numéros de tickets, noms des services et, selon la configuration, des références clients limitées) ; l’Agence est responsable de la licéité de cet affichage.

8. CONSERVATION
Nous conservons les données à caractère personnel uniquement pendant le temps nécessaire aux finalités des traitements :
- Données de compte : pendant la durée de vie du compte, puis suppression ou anonymisation, à l’exception des données exigées par la loi.
- Codes de vérification : durée de vie technique courte (minutes) ; journaux de remise conservés jusqu’à 12 mois.
- Données de tickets, de files d’attente et d’historique : conservées afin de fournir votre historique ainsi que l’exploitation et les statistiques des Agences ; supprimées ou anonymisées après un délai maximal de 24 mois suivant la dernière activité, sauf demande de suppression antérieure de votre part ou obligation légale de conservation plus longue.
- Documents de paiement et de facturation : conservés pendant la période requise par les règles commerciales et comptables algériennes.
- Journaux de sécurité et d’audit : conservés jusqu’à 12 mois.
- Enregistrements de consentement : conservés pendant la durée de la relation de compte, puis à titre de preuve, jusqu’à 10 ans.

9. SÉCURITÉ
Nous mettons en œuvre des mesures techniques et organisationnelles appropriées aux risques, conformément aux obligations de sécurité de la loi n° 18-07 : transport chiffré (TLS), empreintes de hachage des mots de passe, contrôles d’accès et séparation des tâches, mécanismes d’appariement des appareils, journalisation d’audit, sauvegardes et surveillance continue. En cas de violation de données à caractère personnel susceptible d’affecter vos droits, nous notifions l’Autorité nationale de protection des données à caractère personnel (ANPDP) et les personnes concernées, comme l’exige la loi.

10. VOS DROITS
En application de la loi n° 18-07, vous disposez, pour les données que nous traitons en qualité de responsable du traitement, des droits suivants :
(a) accéder à vos données à caractère personnel et en obtenir une copie ;
(b) rectifier les données inexactes ou incomplètes (vous pouvez également modifier vous-même la plupart des données de votre profil) ;
(c) vous opposer, pour des motifs légitimes, au traitement de vos données ;
(d) demander la suppression de votre compte et des données que nous n’avons plus d’obligation légale de conserver ;
(e) retirer à tout moment votre consentement pour les traitements fondés sur le consentement (par exemple le marketing).
Vous pouvez exercer ces droits depuis les paramètres de votre profil, ou en contactant l’assistance par les canaux officiels publiés sur blastidz.online. Nous répondons dans un délai raisonnable n’excédant pas un mois. Si vous estimez que vos droits ne sont pas respectés, vous pouvez déposer une réclamation auprès de l’Autorité nationale de protection des données à caractère personnel (ANPDP).

11. DONNÉES DES ENFANTS
La Plateforme n’est pas destinée aux mineurs non accompagnés. Les comptes des mineurs requièrent le consentement et la participation d’un parent ou d’un représentant légal, conformément à la loi n° 18-07. Si nous apprenons qu’un compte appartient à un mineur non accompagné, nous le désactivons et supprimons les données associées.

12. COOKIES ET STOCKAGE LOCAL
La Plateforme stocke dans votre navigateur ou votre appareil un ensemble minimal d’éléments techniques strictement nécessaires à son fonctionnement : l’authentification de session (cookie sécurisé ou jeton local), votre préférence de langue et vos paramètres d’affichage. Aucun traceur publicitaire n’est utilisé. Vous pouvez les effacer depuis les paramètres de votre navigateur ; les éléments de session essentiels sont recréés lors de votre prochaine connexion.

13. MODIFICATIONS DE LA PRÉSENTE POLITIQUE
Nous pouvons mettre à jour la présente Politique ; les changements substantiels sont notifiés dans la Plateforme et la nouvelle version entre en vigueur à la date indiquée. Le consentement manifesté lors de votre prochaine interaction sensible (par exemple une réinscription ou la création d’un nouveau compte) se réfère à la version alors en vigueur.

14. CONTACT ET ANPDP
Pour exercer vos droits ou pour toute question relative à la présente Politique : utilisez la section d’assistance de la Plateforme ou les adresses de contact publiées sur blastidz.online. Vous pouvez également saisir l’Autorité nationale de protection des données à caractère personnel (ANPDP), l’autorité de contrôle instituée par la loi n° 18-07.`,
  },
}
