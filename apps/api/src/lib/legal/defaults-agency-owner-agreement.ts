// ─── Legal document defaults (master English text) ──────────────────────────
// Agency Owner (business) agreement for the Blasti queue-management platform.
// Crafted against Algerian law: Law 18-07 (personal data), Law 18-05
// (e-commerce), Law 09-03 (consumer protection), Law 15-04 (electronic
// signature and certification), Civil Code (Ord. 75-58), Commercial Code
// (Ord. 75-59). Citation audit (0.6.120): 18-05 = 10 May 2018 e-commerce
// law; the wrong "18-10 e-commerce" citation (18-10 is the apprenticeship
// law) has been removed; 15-04 dates from 1 February 2015.

import type { LegalDocDefault } from './defaults-customer-agreement'

export const agencyOwnerAgreementDefault: LegalDocDefault = {
  docType: 'AGREEMENT_AGENCY_OWNER',
  title: 'Blasti Agency Owner Agreement (Business Terms of Service)',
  content: `This Blasti Agency Owner Agreement ("Agreement") is a binding contract between the business or institution that registers as the owner of an agency account ("you", "the Agency Owner", "the Agency") and the operator of the Blasti platform ("Blasti", "we", "the Operator"). It governs your use of the Blasti Platform to manage queues, tickets, branches, staff, devices (kiosks, display screens, printers) and customer relations (together, the "Services"). By creating an agency, ticking the consent box, or using the Services, you accept this Agreement and the Blasti Privacy Policy.

This Agreement is governed by the laws of the People's Democratic Republic of Algeria, in particular Law No. 18-07 of 10 June 2018 on the protection of natural persons in the processing of personal data, Law No. 18-05 of 10 May 2018 on electronic commerce, Law No. 09-03 of 25 February 2009 on consumer protection and the repression of fraud, Law No. 15-04 of 1 February 2015 fixing the general rules applicable to electronic signature and certification, the Civil Code (Ordinance No. 75-58) and the Commercial Code (Ordinance No. 75-59).

1. DEFINITIONS
- "Platform": the Blasti software service (web, desktop and device applications) for queue and ticket management.
- "Agency account": the workspace you administer on the Platform, including branches, services, staff sub-accounts and connected devices.
- "Staff account": a sub-account you create for your employees to operate the Services on your behalf.
- "Customer": a natural person who takes a ticket or reservation at your Agency through the Platform.

2. ELIGIBILITY AND REGISTRATION
2.1. You represent and warrant that you are a legally constituted business or institution registered in Algeria and, where applicable, enrolled in the Commercial Register (RC), holding a tax identification number (NIF) and, where applicable, a social identification number (NIS), and that you are duly authorised to accept this Agreement on the Agency's behalf.
2.2. Information submitted at registration (identity, contact details, address, wilaya, agency code) must be accurate and kept up to date. Blasti may request supporting documents to verify the Agency's identity, in application of its security obligations.
2.3. The agency code (custom code) reserved on the Platform is a technical identifier, not a trademark right; it must not infringe the rights of third parties.

3. THE SERVICES
Blasti provides the Agency with tools including: queue and counter management, ticket issuance, reservations, display screens (TV boards), self-service kiosks, queue calling, notifications to Customers, analytics dashboards, staff and branch administration, and optional electronic payments. The Services evolve over time; functional changes that do not reduce core features do not require amendment of this Agreement.

4. ACCOUNT ADMINISTRATION AND RESPONSIBILITY FOR STAFF ACCOUNTS
4.1. As the Agency Owner you are the administrator of the Agency account. You are responsible for: the creation, roles, permissions and conduct of Staff accounts; the accuracy of data they enter; and compliance of their use of the Platform with this Agreement.
4.2. Staff accounts may only be created for persons who are your employees or authorised representatives. You must ensure, before or at the time of creation, that each staff member is informed of and accepts the applicable Blasti Staff User Agreement and Privacy Policy; the Platform records the consent shown at creation.
4.3. You remain fully liable towards Blasti and towards third parties for actions performed through Staff accounts, within the limits of the Algerian Civil Code.

5. ACCURACY OF THE AGENCY PROFILE AND INFORMATION DUTIES
5.1. The profile published to Customers (name, category, address, contact numbers, opening hours, services, and any tariff information) must be truthful, current and not misleading, in application of Law No. 09-03 (prohibition of misleading practices) and, where you sell online, the pre-contractual information duties of Law No. 18-05 on electronic commerce.
5.2. Where you sell services through the Platform, you are the "supplier" within the meaning of Law No. 18-05 on electronic commerce and must comply with the resulting obligations towards consumers (information, order process, price display in DZD, conformity, withdrawal where applicable). Blasti is a technical means of display and payment, not the supplier.

6. SUBSCRIPTIONS, BILLING AND TAXES
6.1. Access to the Services is provided under the subscription tier chosen by the Agency (FREE or paid tiers), subject to its limits (staff seats, branches, features). Paid subscriptions are billed in Algerian Dinars (DZD) for the chosen period.
6.2. Payment is made electronically through certified Algerian payment providers (for example CIB / EDAHABIA via the Chargily gateway). Blasti does not store your card data.
6.3. Subscriptions renew at the end of each period unless cancelled before renewal. Refunds for unused periods after renewal follow the refund policy published on the Platform and the rules of Law No. 18-05 on electronic commerce.
6.4. You are responsible for your own tax, accounting and social obligations (VAT and any other applicable duties); prices on the Platform are displayed inclusive or exclusive of taxes as stated at purchase.

7. DEVICES AND LOCAL NETWORK
7.1. Where you connect devices to the Services (Windows PCs, kiosks, TV screens, printers, smartphones), you are responsible for their physical security, their operating-system updates, the configuration of your local network, and the custody of pairing credentials and device tokens.
7.2. Device pairing establishes a secured link between the device and your Agency account. A device that is sold, lost or retired must be unlinked from the Agency account by you; you remain responsible for activity carried out through unlinked-but-not-revoked devices.
7.3. The desktop application operates a local service on your network for offline continuity; you must keep it isolated from the public internet in accordance with the configuration guidance provided by Blasti.

8. CUSTOMER PERSONAL DATA
8.1. Within the processing carried out on the Platform, Blasti acts as the data controller for the account, subscription and security data of the Agency Owner and Staff accounts, and provides the technical processing environment for the data of Customers who take tickets at your Agency.
8.2. You are separately responsible, as data controller of your own processing, for the compliance of your use of Customer data with Law No. 18-07: informing Customers, processing data only for the purposes of serving them, honouring their requests (access, rectification, opposition), keeping the data secure, making to the ANPDP (National Authority for the Protection of Personal Data) the declaration or authorisation your processing requires, and addressing the ANPDP when required.
8.3. You must not export, retain beyond necessity, or reuse Customer data collected through the Platform for purposes unrelated to the Agency-customer relationship (in particular, not for unsolicited mass marketing contrary to Law No. 18-05 and Law No. 09-03).
8.4. The Platform displays queue information on screens in your premises (ticket numbers, service names, and where configured, limited customer references). You are responsible for ensuring this display complies with Law No. 18-07 and does not disclose excessive personal data.

9. ACCEPTABLE USE AND PLATFORM INTEGRITY
You undertake NOT to: (a) use the Services for unlawful activities or activities contrary to public order; (b) manipulate ratings or reviews (Astroturfing), which is also prohibited under Law No. 09-03; (c) interfere with other agencies' queues or data; (d) reverse engineer, resell or provide the Services to third parties as a service bureau without written agreement; (e) overload, probe or attack the Platform infrastructure; (f) send unlawful communications to Customers through Platform channels.

10. SERVICE LEVELS AND SUPPORT
10.1. Blasti endeavours to keep the cloud Platform available 24/7 and desktops functional offline through the local service; the Services are provided on an efforts basis without a contractual availability guarantee except where a specific service-level commitment is subscribed in writing.
10.2. Support is provided through the official channels published in the Platform.

11. INTELLECTUAL PROPERTY
11.1. The Platform, its software, brand, logos, interfaces and documentation are protected property. Blasti grants the Agency a non-exclusive, non-transferable licence, limited in time to the subscription, to use the Services for the Agency's own business.
11.2. The Agency retains all rights in its own content (name, logo, descriptions, services) and grants Blasti the licence strictly necessary to host and display that content on the Platform at the Agency's request.

12. CONFIDENTIALITY
Each party keeps the other party's confidential information (including technical documentation, pricing, and non-public data) secret and uses it only for the performance of this Agreement, for the duration of the Agreement and after its end.

13. REPRESENTATIONS, WARRANTIES AND INDEMNITY
13.1. Blasti represents that it will perform the Services with professional care. Except as expressly stated, the Services are provided as is, and Blasti gives no other warranty, express or implied.
13.2. You indemnify Blasti against third-party claims (including Customers, employees and authorities) arising from your use of the Services, the content of your profile, the services you sell, or your processing of Customer data, within the limits of the Algerian Civil Code.

14. LIMITATION OF LIABILITY
14.1. Blasti's total liability for all claims related to the Services is limited, per subscription year, to the amounts actually paid by the Agency to Blasti during that year, except in cases of intentional fault or gross negligence.
14.2. Blasti is not liable for indirect damages: loss of turnover, loss of Customers, commercial prejudice, or the consequences of the Agency's own operating decisions.

15. SUSPENSION AND TERMINATION
15.1. Either party may terminate the subscription at its expiry. Blasti may suspend the Services for non-payment of a due invoice (after notice), for a serious breach of this Agreement, or for legal or security reasons.
15.2. Upon termination, the Agency may export its core operational data through the Platform's export features for a period of thirty (30) days, after which Blasti may delete the Agency's data in accordance with its retention schedule, save for records the law requires to be kept.

16. FORCE MAJEURE
Neither party is liable for a failure caused by force majeure within the meaning of the Algerian Civil Code (natural disasters, public-authority decisions, network, energy or telecommunications failures).

17. CHANGES TO THIS AGREEMENT
Blasti may amend this Agreement. Material changes are notified before they take effect; continuing the subscription after the effective date constitutes acceptance. If you do not accept the changes, you may terminate at the end of the current period.

18. GOVERNING LAW AND JURISDICTION
This Agreement is governed by Algerian law. Disputes are first sought to be settled amicably; failing settlement, the competent Algerian courts have jurisdiction.

19. CONTACT
Blasti support: through the official channels published on blastidz.online. Personal-data complaints may be addressed to the National Authority for the Protection of Personal Data (ANPDP).`,
}
