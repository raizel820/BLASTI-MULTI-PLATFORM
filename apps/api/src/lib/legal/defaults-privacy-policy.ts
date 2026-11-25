// ─── Legal document defaults (master English text) ──────────────────────────
// Platform privacy policy — applies to all account types (customers, agency
// owners, staff) and to data collected through devices. Crafted against
// Law 18-07 of 10 June 2018 (ANPDP), Law 18-05 of 10 May 2018 (e-commerce),
// Law 09-03 (consumer protection), Law 15-04 (electronic signature and
// certification), Presidential Decree 20-05 of 20 January 2020 (national
// information-systems security framework).

import type { LegalDocDefault } from './defaults-customer-agreement'

export const privacyPolicyDefault: LegalDocDefault = {
  docType: 'PRIVACY_POLICY',
  title: 'Blasti Privacy Policy',
  content: `This Privacy Policy ("Policy") explains how the operator of the Blasti platform ("Blasti", "we", "the Operator") collects and processes the personal data of persons who use the Blasti website, mobile application, desktop application and connected devices (together, the "Platform"): customers, agency owners and staff users. It applies to all account types.

This Policy is written in accordance with Law No. 18-07 of 10 June 2018 on the protection of natural persons in the processing of personal data, which established the National Authority for the Protection of Personal Data ("ANPDP"), as well as Law No. 18-05 of 10 May 2018 on electronic commerce, Law No. 09-03 of 25 February 2009 on consumer protection and the repression of fraud, Law No. 15-04 of 1 February 2015 fixing the general rules applicable to electronic signature and certification, and Presidential Decree No. 20-05 of 20 January 2020 establishing the national framework for the security of information systems. It forms an integral part of the Blasti user agreements.

1. WHO IS RESPONSIBLE FOR YOUR DATA
The controller of the processing described in this Policy is the Operator of the Blasti Platform, whose identity and contact details are published in the Platform's support section and on blastidz.online. The Operator makes to the ANPDP the declarations and, where required, the authorisation requests provided for by Law No. 18-07 for the processing operations it carries out as controller. For the processing that an agency performs on its customers' data in the course of serving them (its files, its relations, its services), the agency is the controller and Blasti provides the technical processing environment; see Section 7.

2. DATA WE COLLECT
Depending on your account type and your use of the Platform, we process:
2.1. Account and identity data: username, full name, e-mail address, mobile phone number, password (stored only as an irreversible hash), profile photo, language, wilaya and commune (where you provide them), and your platform user identifier.
2.2. Verification data: one-time verification codes sent by e-mail or SMS/WhatsApp, and their delivery status; logs of verification events.
2.3. Ticket and queue data: tickets and reservations taken at agencies, service requested, counters, timestamps, waiting and serving times, cancellations, no-show flags, and your history of visits.
2.4. Reviews and ratings you submit, and favourites you choose.
2.5. Payment data: for paid subscriptions or paid services, billing identifiers and transaction references processed through certified Algerian payment providers (CIB / EDAHABIA via the Chargily gateway). We do not collect or store your full card number or card secret codes.
2.6. Device and technical data: device identifiers used for pairing agency devices (kiosks, PCs, TVs, printers), application version, platform (web/mobile/desktop), IP address at security-relevant events, and diagnostic logs you or your agency transmit for support purposes.
2.7. Agency data (for agency owners): agency identity, registration details you enter, branches, services, opening hours, and operational statistics.
2.8. Staff data (for staff accounts): name, contact details, activity logs, and the permissions granted by the agency owner.

3. PURPOSES OF PROCESSING AND LEGAL BASES
We process your personal data only for specified, explicit and legitimate purposes:
(a) To create and secure your account, verify your contact details and authenticate you — based on your consent given at registration and on the performance of the user agreement.
(b) To provide the queue-management service: issuing tickets and reservations, following your turn, notifying you when your turn approaches — performance of the user agreement.
(c) To allow agencies to serve you and manage their queues — performance of the agreements of both parties.
(d) To process payments for paid services and subscriptions and to handle invoicing — performance of the agreement and legal accounting obligations.
(e) To ensure the security of the Platform, detect fraud and abuse, keep audit logs, and comply with legal obligations — legitimate security interests and legal obligations.
(f) To send service notifications related to your tickets and account — performance of the agreement. Marketing communications are sent only with your separate, withdrawable consent.
(g) To produce aggregated statistics and improve the service — legitimate interests, on anonymised or aggregated data wherever possible.

4. CONSENT
At registration and at the creation of staff and agency accounts, we collect your free, specific and informed consent to this Policy and to the applicable user agreement, by means of a mandatory consent checkbox. The fact of consent is recorded (document, version, date and time, request IP) so that we can demonstrate it as required by Law No. 18-07. Where processing relies on consent (for example marketing), you may withdraw that consent at any time without affecting the lawfulness of processing already carried out.

5. DATA SHARING
We do not sell your personal data. We share it only with:
(a) The agency you visit or have taken a ticket with, so that it can serve you (identity, ticket, relevant history).
(b) Payment providers (for example Chargily, CIB / EDAHABIA issuers) for the sole purpose of processing your payments.
(c) Communications providers (SMS, WhatsApp, e-mail senders) for the sole purpose of delivering your notifications and verification codes.
(d) Hosting and infrastructure providers operating the Platform servers.
(e) Public authorities, where the law requires or authorises disclosure, upon lawful request.
Each recipient processes data only for the purposes stated here, under contractual confidentiality and security obligations.

6. INTERNATIONAL TRANSFERS
Personal data are hosted and primarily processed on servers located in accordance with Article 44 of Law No. 18-07: no transfer to a foreign country takes place unless that country ensures an adequate level of protection or the transfer is authorised by the ANPDP, or an exception provided by law applies. Where technical routing makes a transient transfer unavoidable (for example message delivery), it is limited to the strict minimum necessary and protected by appropriate safeguards.

7. AGENCIES AND THEIR RESPONSIBILITY
When an agency uses the Platform to serve you, the agency acts as controller of the processing it performs on your data within its own establishment. Blasti provides it with technical tools (queue management, displays, kiosks, notifications) and contractually requires agencies to respect Law No. 18-07, to use your data only to serve you, and to honour your requests. Screens in agencies display queue information (ticket numbers, service names and, where configured, limited customer references); the agency is responsible for the lawfulness of that display.

8. RETENTION
We keep personal data only for the time necessary for the purposes of processing:
- Account data: for the life of the account, then deleted or anonymised, except data required by law.
- Verification codes: short technical lifetime (minutes), delivery logs up to 12 months.
- Ticket, queue and history data: retained to provide your history and the agencies' operations and statistics; deleted or anonymised after a maximum period of 24 months after the last activity, unless you request deletion earlier or a legal obligation requires longer retention.
- Payment and billing records: retained for the period required by Algerian commercial and accounting rules.
- Security and audit logs: retained up to 12 months.
- Consent records: retained for the duration of the account relationship and afterwards as evidence, up to 10 years.

9. SECURITY
We implement technical and organisational measures appropriate to the risks, in accordance with the security obligations of Law No. 18-07: encrypted transport (TLS), password hashing, access controls and separation of duties, device pairing mechanisms, audit logging, backups, and continuous monitoring. In case of a personal-data breach likely to affect your rights, we notify the ANPDP and affected persons as required by law.

10. YOUR RIGHTS
Under Law No. 18-07 you have, for the data we process as controller, the right to:
(a) Access your personal data and obtain a copy;
(b) Rectify inaccurate or incomplete data (you can also edit most profile data yourself);
(c) Object, on legitimate grounds, to the processing of your data;
(d) Request deletion of your account and of the data we no longer have a legal obligation to keep;
(e) Withdraw consent for consent-based processing (for example marketing) at any time.
You can exercise these rights from your profile settings, or by contacting support through the official channels published on blastidz.online. We respond within a reasonable period not exceeding one month. If you consider that your rights are not respected, you may lodge a complaint with the ANPDP.

11. CHILDREN'S DATA
The Platform is not intended for unaccompanied minors. Accounts of minors require the consent and involvement of a parent or legal guardian, in accordance with Law No. 18-07. If we learn that an account belongs to an unaccompanied minor, we deactivate it and delete the associated data.

12. COOKIES AND LOCAL STORAGE
The Platform stores in your browser or device a minimal set of technical elements strictly necessary to operate: session authentication (a secure cookie or local token), your language preference, and your display settings. No advertising trackers are used. You may clear them from your browser settings; essential session elements are re-created on your next login.

13. CHANGES TO THIS POLICY
We may update this Policy; material changes are notified in the Platform and the new version takes effect on the date indicated. The consent shown at your next sensitive interaction (for example a re-registration or a new account creation) references the then-current version.

14. CONTACT AND ANPDP
To exercise your rights or for any question about this Policy: use the Platform's support section or the contact addresses published on blastidz.online. You may also address the National Authority for the Protection of Personal Data (ANPDP), the supervisory authority established by Law No. 18-07.`,
}
