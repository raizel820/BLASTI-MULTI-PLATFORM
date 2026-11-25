// ─── Legal document defaults (master English text) ──────────────────────────
// Customer (end-user) agreement for the Blasti queue-management platform.
// Crafted against Algerian law: Law 18-07 (personal data), Law 18-05
// (e-commerce), Law 09-03 (consumer protection), Law 15-04 (electronic
// signature and certification), Civil Code (Ord. 75-58). Arabic/French
// translations live in ./ar-defaults.ts and ./fr-defaults.ts and are merged
// by ./index.ts.
//
// Citation audit (0.6.120): Law 18-05 is the 10 May 2018 e-commerce law
// (NOT "electronic data and documents"); the former "Law 18-10 e-commerce"
// citation was wrong (18-10 is the 10 June 2018 apprenticeship law) and has
// been removed; Law 15-04 dates from 1 February 2015.

export interface LegalDocDefault {
  docType: string
  title: string
  content: string
}

export const customerAgreementDefault: LegalDocDefault = {
  docType: 'AGREEMENT_CUSTOMER',
  title: 'Blasti Customer Agreement (Terms of Use)',
  content: `This Blasti Customer Agreement ("Agreement") is a binding contract between you ("you", "the Customer") and the operator of the Blasti platform ("Blasti", "we", "the Operator"). It governs your use of the Blasti website, mobile application and any related service (together, the "Platform"). By creating an account, ticking the consent box at registration, or otherwise using the Platform, you accept this Agreement and the Blasti Privacy Policy.

This Agreement is written in accordance with the laws of the People's Democratic Republic of Algeria, in particular Law No. 18-07 of 10 June 2018 on the protection of natural persons in the processing of personal data, Law No. 18-05 of 10 May 2018 on electronic commerce, Law No. 09-03 of 25 February 2009 on consumer protection and the repression of fraud, and Law No. 15-04 of 1 February 2015 fixing the general rules applicable to electronic signature and electronic certification.

1. DEFINITIONS
- "Platform": the Blasti software service (web, mobile and device applications) that lets Customers obtain numbered queue tickets, make reservations and follow their turn at agencies that use Blasti.
- "Agency": a business or institution (clinic, administration, bank branch, and any other category) that uses the Platform to manage its queues and serve its customers.
- "Ticket" or "Reservation": a numbered place in an Agency's queue obtained through the Platform.
- "Account": your registered user profile on the Platform.

2. ELIGIBILITY AND REGISTRATION
2.1. You must have the legal capacity to contract under the Algerian Civil Code. Minors may use the Platform only with the involvement and consent of a parent or legal guardian, whose personal-data consent is required under Law No. 18-07.
2.2. Registration requires accurate and truthful information: full name, a valid e-mail address, a valid Algerian mobile number, and, where requested, your wilaya and commune. Providing false identity data may lead to suspension of your Account.
2.3. One person may hold one account. You are responsible for the activity carried out through your Account and for keeping your credentials confidential.

3. NATURE OF THE PLATFORM — TECHNICAL INTERMEDIARY
3.1. Blasti provides a technical tool for queue management. Blasti is not the supplier of the services that Agencies render (medical consultation, banking, administration, etc.): the contract for the Agency's service is formed directly and exclusively between you and the Agency.
3.2. Blasti does not intervene in the content, quality, price, scheduling or outcome of the services provided by Agencies, and makes no representation or warranty about them. Commercial, consumer-protection and professional-liability obligations concerning the Agency's service rest on the Agency alone, under Law No. 09-03 and the applicable professional rules.
3.3. Information displayed about an Agency (hours, address, services, tariffs where shown) is provided by that Agency, which remains responsible for its accuracy.

4. TICKETS, RESERVATIONS AND NO-SHOWS
4.1. When you take a ticket or a reservation through the Platform, a queue position is reserved for you at the Agency according to its configuration.
4.2. You must arrive in reasonable time before your turn. Repeated absence after taking tickets ("no-show") may, in accordance with the Agency's published policy, lead the Agency to restrict your ability to take further tickets through the Platform.
4.3. Cancellation: you may cancel a ticket or reservation from the Platform before it is called, where the feature is enabled by the Agency.
4.4. The order of passage and the estimated waiting time are estimates produced by the Platform for information only; actual service times depend on the Agency.

5. PAYMENTS
5.1. Where an Agency activates paid services through the Platform, prices are displayed in Algerian Dinars (DZD), inclusive of applicable taxes where required. Payment is collected electronically through certified Algerian payment providers (for example CIB / EDAHABIA via the Chargily gateway).
5.2. Blasti does not store your bank card data. Card details are processed by the certified payment provider under its own security obligations.
5.3. Refunds and the exercise of consumer rights relating to a paid Agency service are handled with the Agency, in accordance with Law No. 09-03 and Law No. 18-05; Blasti assists technically by transmitting the refund instruction to the payment provider when applicable.
5.4. Where a paid offering is concluded at a distance within the meaning of Law No. 18-05 on electronic commerce, the statutory right of withdrawal applicable to distance sales contracts (Law No. 18-05 and Law No. 09-03) is exercised towards the supplier of the service concerned: the Agency for the Agency's own services, Blasti for platform subscriptions under the conditions published on the Platform. The exercise of the withdrawal right, where it applies, follows the statutory conditions and time limits in force in Algeria.

6. ELECTRONIC COMMUNICATIONS
6.1. You consent to receive service notifications (SMS, WhatsApp, e-mail or push) concerning your tickets, reservations and Account, including necessary security notices.
6.2. Under Law No. 18-05 on electronic commerce and Law No. 15-04 on electronic signature and certification, electronic documents, agreements and notifications exchanged through the Platform have the same evidential value as paper documents; an agreement concluded or accepted electronically cannot be contested solely on the ground that it is in electronic form.
6.3. Marketing communications are sent only with your separate consent, which you may withdraw at any time from your profile settings.

7. PERSONAL DATA AND PRIVACY
7.1. Your personal data are processed in accordance with the Blasti Privacy Policy, which forms an integral part of this Agreement, and in accordance with Law No. 18-07.
7.2. At registration you give free, specific and informed consent to the processing of your data for the purposes described in the Privacy Policy. Your consent is recorded (document, version, date) so that it can be demonstrated. You may withdraw consent and exercise your rights as described in the Privacy Policy.
7.3. The data concerning your tickets may be displayed to the Agency you visit so that you can be served; queue displays in Agencies show ticket numbers and, where configured by the Agency, limited service information.

8. ACCEPTABLE USE
You undertake NOT to: (a) create accounts under a false identity or for automated mass booking; (b) take tickets you do not intend to honour so as to disturb the Agency's queue; (c) resell, transfer or monetise queue positions; (d) attempt to circumvent queue order, ticket numbering or device checks; (e) probe, scan or attack the Platform's technical infrastructure, or introduce malicious code; (f) use the Platform in a manner contrary to Algerian law, public order or good morals.

9. INTELLECTUAL PROPERTY
The Platform, its software, brand, logos, interfaces and content are protected by copyright and related rights. Blasti grants you a personal, non-exclusive, non-transferable, revocable licence to use the Platform for your own non-commercial purposes. Any other use, reproduction or exploitation without prior written authorisation is prohibited.

10. AVAILABILITY
Blasti strives to keep the Platform available and to correct faults within reasonable time. However, the Platform is provided on an efforts basis: interruptions (maintenance, network, electricity, telecommunications) may occur, and Blasti may suspend access for maintenance or for serious security reasons, informing you when practicable.

11. LIMITATION OF LIABILITY
11.1. To the maximum extent permitted by the Algerian Civil Code, Blasti's liability for any damage related to the Platform is limited to direct, personal and certain damage, and excludes indirect damage, loss of data not caused by Blasti's fault, loss of opportunity or commercial loss.
11.2. Blasti is not liable for the acts or omissions of Agencies, nor for the execution, quality or cancellation of the Agency's services.
11.3. Nothing in this Agreement excludes liability that cannot lawfully be excluded, including liability for death or personal injury caused by fault, or liability towards consumers that is mandatory under Law No. 09-03.

12. FORCE MAJEURE
Neither party is liable for failure to perform caused by force majeure within the meaning of the Algerian Civil Code, including natural disasters, decisions of public authorities, network or telecommunications failures and power outages.

13. SUSPENSION AND TERMINATION
13.1. You may stop using the Platform and request deletion of your Account at any time from your profile or by contacting support.
13.2. Blasti may suspend or close an Account that violates this Agreement, that is used for fraud, or that creates a security risk, after notice where practicable. Sections that by their nature survive termination (data protection, liability, governing law) remain in force.

14. CHANGES TO THIS AGREEMENT
Blasti may amend this Agreement. Material changes are notified in the Platform before they take effect. Continued use of the Platform after the effective date of a new version constitutes acceptance. If you do not accept a change, you must stop using the Platform and may request Account deletion.

15. GOVERNING LAW AND JURISDICTION
This Agreement is governed by Algerian law. Any dispute relating to the Platform is submitted to the attempt of amicable settlement first; failing settlement, the competent Algerian courts have jurisdiction, without prejudice to the rules of consumer jurisdiction under Law No. 09-03.

16. CONTACT
For questions about this Agreement or to exercise your rights: through the in-app support section, or at the support address published on blastidz.online. Complaints concerning personal data may also be addressed to the National Authority for the Protection of Personal Data (ANPDP).`,
}
