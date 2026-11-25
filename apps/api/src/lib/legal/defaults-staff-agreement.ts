// ─── Legal document defaults (master English text) ──────────────────────────
// Staff user agreement for the Blasti queue-management platform. Staff
// accounts are created by the agency owner; this document binds the staff
// member individually. Crafted against Algerian law: Law 18-07 (personal
// data), Law 18-05 (e-commerce), Law 15-04 (electronic signature and
// certification), Civil Code, Labor Law 90-11.

import type { LegalDocDefault } from './defaults-customer-agreement'

export const staffAgreementDefault: LegalDocDefault = {
  docType: 'AGREEMENT_STAFF',
  title: 'Blasti Staff User Agreement',
  content: `This Blasti Staff User Agreement ("Agreement") governs the use of a staff sub-account on the Blasti platform ("Platform") by the employee or authorised representative for whom it was created ("you", "the Staff User"). It is concluded between you and the operator of the Platform ("Blasti", "we", "the Operator"). By being created a staff account and ticking the consent box shown at creation, or by first using the staff account, you accept this Agreement and the Blasti Privacy Policy.

This Agreement is governed by the laws of the People's Democratic Republic of Algeria, in particular Law No. 18-07 of 10 June 2018 on the protection of natural persons in the processing of personal data, Law No. 18-05 of 10 May 2018 on electronic commerce (your electronic acceptance of this Agreement forms an electronic contract that has the same evidential value as a paper one), Law No. 15-04 of 1 February 2015 fixing the general rules applicable to electronic signature and certification, and the Civil Code (Ordinance No. 75-58).

1. DEFINITIONS
- "Platform": the Blasti software service (web, desktop and device applications).
- "Agency": the business whose account your staff sub-account belongs to; its owner is the "Agency Owner".
- "Staff account": the sub-account created for you to serve customers, manage counters and queues, and use the features the Agency Owner grants you.

2. ACCOUNT CREATION AND ADMINISTRATION
2.1. Your staff account is created by the Agency Owner (or, exceptionally, by the platform administration). Blasti does not decide who receives a staff account; access, roles and permissions are chosen by the Agency Owner.
2.2. Your account is personal. You must not share your username, password or one-time codes with any other person. Any activity carried out through your account is presumed to be yours unless you report a compromise without undue delay.
2.3. You must use a strong password and immediately report to the Agency Owner and to Blasti support any suspected compromise of your credentials.

3. RELATIONSHIP WITH THE AGENCY — NOT AN EMPLOYMENT CONTRACT
3.1. This Agreement concerns the software account only. It does not create, modify or replace any employment contract or service relationship between you and the Agency, which remains governed by Algerian labour law (Law No. 90-11 of 21 April 1990), your contract, and the Agency's internal rules.
3.2. Blasti is not a party to your employment relationship and does not manage your remuneration, working hours, leave or discipline; it only provides the technical tool used in the course of that relationship.

4. USE OF THE STAFF ACCOUNT
4.1. You use the Platform to serve the Agency's customers: calling and serving tickets, managing counters, consulting queues and analytics, and other functions the Agency Owner grants you.
4.2. You must use the Platform diligently, honestly and only within the permissions granted to you. You must not attempt to access data or functions beyond your role (other branches, other agencies, other users' data, administrative functions).
4.3. You must not use the Platform for personal purposes unrelated to your work, nor to the detriment of customers or of the Agency.

5. CONFIDENTIALITY AND PERSONAL DATA
5.1. Through the staff account you will see personal data of customers (names, contact details, tickets, history) and of the Agency. You must keep all such data confidential, use it solely to perform your duties for the Agency, and never disclose, copy or reuse it outside the Platform for any other purpose. This obligation continues after your account is deactivated.
5.2. Your processing of customer data through the Platform must comply with Law No. 18-07: purpose limitation, security, and referral of customer requests (access, rectification, opposition) to the Agency Owner.
5.3. Blasti processes your own account data (name, contact, activity logs) as described in the Privacy Policy, based on your consent shown at account creation and on the legitimate security needs of the service.

6. PROHIBITED CONDUCT
You undertake NOT to: (a) disclose your credentials; (b) create, edit or delete data in bad faith (fake tickets, altered records, deleted history); (c) harass or mistreat customers through Platform channels; (d) export or screenshot customer data for purposes outside your duties; (e) interfere with the technical integrity of the Platform, devices or network; (f) use the account after the end of your relationship with the Agency.

7. SUSPENSION, DEACTIVATION AND TERMINATION
7.1. The Agency Owner may suspend, restrict or deactivate your staff account at any time, in particular when your relationship with the Agency ends. Blasti may disable an account for a serious breach of this Agreement, suspected compromise, or legal reasons.
7.2. Upon deactivation you lose access to the Platform; the confidentiality obligations of Section 5 survive.

8. LIABILITY
8.1. You are liable, towards the Agency and within the limits of the Algerian Civil Code, for damage caused to the Platform or to data by your intentional misconduct or gross negligence in the use of the staff account.
8.2. Blasti's liability regarding the Platform is limited to direct damage and to the obligations of a software provider on an efforts basis; Blasti is not liable for the acts of the Agency Owner or of the Agency.

9. CHANGES TO THIS AGREEMENT
Blasti may amend this Agreement; material changes are notified in the Platform. Continued use of the staff account after the effective date of a new version constitutes acceptance.

10. GOVERNING LAW AND JURISDICTION
This Agreement is governed by Algerian law. Disputes relating to the staff account itself are first sought to be settled amicably with Blasti support; failing settlement, the competent Algerian courts have jurisdiction. Disputes with the Agency are outside the scope of this Agreement.

11. CONTACT
Blasti support: through the official channels published on blastidz.online. Complaints concerning personal data may also be addressed to the National Authority for the Protection of Personal Data (ANPDP).`,
}
