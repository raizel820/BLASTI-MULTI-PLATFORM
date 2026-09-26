/**
 * Algeria administrative divisions — 58 wilayas and 1541 communes (baladiyas).
 * Data source: algeria-cities open dataset (commune names in Arabic + Latin).
 * Wilaya codes are the official two-digit ANI codes ('01'-'58').
 *
 * Used by the register form and the create-agency form address selectors.
 * Keep this file pure data — no side effects, tree-shakeable.
 */

export interface AlgeriaCommune {
  /** Latin commune name, e.g. "Bab El Oued" */
  name: string;
  /** Arabic commune name, e.g. "باب الوادي" */
  nameAr: string;
}

export interface AlgeriaWilaya {
  /** Official two-digit wilaya code, e.g. '16' for Alger */
  code: string;
  /** Latin wilaya name, e.g. "Alger" */
  name: string;
  /** Arabic wilaya name, e.g. "الجزائر" */
  nameAr: string;
  /** Communes (baladiyas) belonging to this wilaya, sorted by Latin name */
  communes: AlgeriaCommune[];
}

export const ALGERIA_WILAYAS: AlgeriaWilaya[] = [
  {
    code: '01',
    name: 'Adrar',
    nameAr: 'أدرار',
    communes: [ { name: 'Adrar', nameAr: 'أدرار' }, { name: 'Akabli', nameAr: 'اقبلي' }, { name: 'Aoulef', nameAr: 'أولف' }, { name: 'Bouda', nameAr: 'بودة' }, { name: 'Fenoughil', nameAr: 'فنوغيل' }, { name: 'In Zghmir', nameAr: 'إن زغمير' }, { name: 'Ouled Ahmed Timmi', nameAr: 'أولاد أحمد تيمي' }, { name: 'Reggane', nameAr: 'رقان' }, { name: 'Sali', nameAr: 'سالي' }, { name: 'Sebaa', nameAr: 'السبع' }, { name: 'Tamantit', nameAr: 'تامنطيط' }, { name: 'Tamest', nameAr: 'تامست' }, { name: 'Timekten', nameAr: 'تيمقتن' }, { name: 'Tit', nameAr: 'تيت' }, { name: 'Tsabit', nameAr: 'تسابيت' }, { name: 'Zaouiet Kounta', nameAr: 'زاوية كنتة' },
    ],
  },
  {
    code: '02',
    name: 'Chlef',
    nameAr: ' الشلف',
    communes: [ { name: 'Abou El Hassane', nameAr: 'أبو الحسن' }, { name: 'Ain Merane', nameAr: 'عين مران' }, { name: 'Benairia', nameAr: 'بنايرية' }, { name: 'Beni  Bouattab', nameAr: 'بني بوعتاب' }, { name: 'Beni Haoua', nameAr: 'بني حواء' }, { name: 'Beni Rached', nameAr: 'بني راشد' }, { name: 'Boukadir', nameAr: 'بوقادير' }, { name: 'Bouzeghaia', nameAr: 'بوزغاية' }, { name: 'Breira', nameAr: 'بريرة' }, { name: 'Chettia', nameAr: 'الشطية' }, { name: 'Chlef', nameAr: 'الشلف' }, { name: 'Dahra', nameAr: 'الظهرة' }, { name: 'El Hadjadj', nameAr: 'الحجاج' }, { name: 'El Karimia', nameAr: 'الكريمية' }, { name: 'El Marsa', nameAr: 'المرسى' }, { name: 'Harchoun', nameAr: 'حرشون' }, { name: 'Herenfa', nameAr: 'الهرانفة' }, { name: 'Labiod Medjadja', nameAr: 'الأبيض مجاجة' }, { name: 'Moussadek', nameAr: 'مصدق' }, { name: 'Oued Fodda', nameAr: 'وادي الفضة' }, { name: 'Oued Goussine', nameAr: 'وادي قوسين' }, { name: 'Oued Sly', nameAr: 'وادي سلي' }, { name: 'Ouled Abbes', nameAr: 'أولاد عباس' }, { name: 'Ouled Ben Abdelkader', nameAr: 'أولاد بن عبد القادر' }, { name: 'Ouled Fares', nameAr: 'أولاد فارس' }, { name: 'Oum Drou', nameAr: 'أم الدروع' }, { name: 'Sendjas', nameAr: 'سنجاس' }, { name: 'Sidi Abderrahmane', nameAr: 'سيدي عبد الرحمن' }, { name: 'Sidi Akkacha', nameAr: 'سيدي عكاشة' }, { name: 'Sobha', nameAr: 'الصبحة' }, { name: 'Tadjena', nameAr: 'تاجنة' }, { name: 'Talassa', nameAr: 'تلعصة' }, { name: 'Taougrit', nameAr: 'تاوقريت' }, { name: 'Tenes', nameAr: 'تنس' }, { name: 'Zeboudja', nameAr: 'الزبوجة' },
    ],
  },
  {
    code: '03',
    name: 'Laghouat',
    nameAr: 'الأغواط',
    communes: [ { name: 'Aflou', nameAr: 'أفلو' }, { name: 'Ain Madhi', nameAr: 'عين ماضي' }, { name: 'Ain Sidi Ali', nameAr: 'عين سيدي علي' }, { name: 'Benacer Benchohra', nameAr: 'بن ناصر بن شهرة' }, { name: 'Brida', nameAr: 'بريدة' }, { name: 'El Assafia', nameAr: 'العسافية' }, { name: 'El Beidha', nameAr: 'البيضاء' }, { name: 'El Ghicha', nameAr: 'الغيشة' }, { name: 'El Haouaita', nameAr: 'الحويطة' }, { name: 'Gueltat Sidi Saad', nameAr: 'قلتة سيدي سعد' }, { name: 'Hadj Mechri', nameAr: 'الحاج مشري' }, { name: 'Hassi Delaa', nameAr: 'حاسي الدلاعة' }, { name: 'Hassi R\'mel', nameAr: 'حاسي الرمل' }, { name: 'Kheneg', nameAr: 'الخنق' }, { name: 'Ksar El Hirane', nameAr: 'قصر الحيران' }, { name: 'Laghouat', nameAr: 'الأغواط' }, { name: 'Oued M\'zi', nameAr: 'وادي مزي' }, { name: 'Oued Morra', nameAr: 'وادي مرة' }, { name: 'Sebgag', nameAr: 'سبقاق' }, { name: 'Sidi Bouzid', nameAr: 'سيدي بوزيد' }, { name: 'Sidi Makhlouf', nameAr: 'سيدي مخلوف' }, { name: 'Tadjemout', nameAr: 'تاجموت' }, { name: 'Tadjrouna', nameAr: 'تاجرونة' }, { name: 'Taouiala', nameAr: 'تاويالة' },
    ],
  },
  {
    code: '04',
    name: 'Oum El Bouaghi',
    nameAr: 'أم البواقي',
    communes: [ { name: 'Ain Babouche', nameAr: 'عين ببوش' }, { name: 'Ain Beida', nameAr: 'عين البيضاء' }, { name: 'Ain Diss', nameAr: 'عين الديس' }, { name: 'Ain Fekroun', nameAr: 'عين فكرون' }, { name: 'Ain Kercha', nameAr: 'عين كرشة' }, { name: 'Ain M\'lila', nameAr: 'عين مليلة' }, { name: 'Ain Zitoun', nameAr: 'عين الزيتون' }, { name: 'Behir Chergui', nameAr: 'بحير الشرقي' }, { name: 'Berriche', nameAr: 'بريش' }, { name: 'Bir Chouhada', nameAr: 'بئر الشهداء' }, { name: 'Dhalaa', nameAr: 'الضلعة' }, { name: 'El Amiria', nameAr: 'العامرية' }, { name: 'El Belala', nameAr: 'البلالة' }, { name: 'El Djazia', nameAr: 'الجازية' }, { name: 'El Fedjoudj Boughrara Sa', nameAr: 'الفجوج بوغرارة سعودي' }, { name: 'El Harmilia', nameAr: 'الحرملية' }, { name: 'Fkirina', nameAr: 'فكيرينة' }, { name: 'Hanchir Toumghani', nameAr: 'هنشير تومغني' }, { name: 'Ksar Sbahi', nameAr: 'قصر الصباحي' }, { name: 'Meskiana', nameAr: 'مسكيانة' }, { name: 'Oued Nini', nameAr: 'وادي نيني' }, { name: 'Ouled Gacem', nameAr: 'أولاد قاسم' }, { name: 'Ouled Hamla', nameAr: 'أولاد حملة' }, { name: 'Ouled Zouai', nameAr: 'أولاد زواي' }, { name: 'Oum El Bouaghi', nameAr: 'أم البواقي' }, { name: 'Rahia', nameAr: 'الرحية' }, { name: 'Sigus', nameAr: 'سيقوس' }, { name: 'Souk Naamane', nameAr: 'سوق نعمان' }, { name: 'Zorg', nameAr: 'الزرق' },
    ],
  },
  {
    code: '05',
    name: 'Batna',
    nameAr: 'باتنة',
    communes: [ { name: 'Ain Djasser', nameAr: 'عين جاسر' }, { name: 'Ain Touta', nameAr: 'عين التوتة' }, { name: 'Ain Yagout', nameAr: 'عين ياقوت' }, { name: 'Arris', nameAr: 'أريس' }, { name: 'Azil Abedelkader', nameAr: 'عزيل عبد القادر' }, { name: 'Barika', nameAr: 'بريكة' }, { name: 'Batna', nameAr: 'باتنة' }, { name: 'Beni Foudhala El Hakania', nameAr: 'بني فضالة الحقانية' }, { name: 'Bitam', nameAr: 'بيطام' }, { name: 'Boulhilat', nameAr: 'بولهيلات' }, { name: 'Boumagueur', nameAr: 'بومقر' }, { name: 'Boumia', nameAr: 'بومية' }, { name: 'Bouzina', nameAr: 'بوزينة' }, { name: 'Chemora', nameAr: 'الشمرة' }, { name: 'Chir', nameAr: 'شير' }, { name: 'Djerma', nameAr: 'جرمة' }, { name: 'Djezzar', nameAr: 'الجزار' }, { name: 'El Hassi', nameAr: 'الحاسي' }, { name: 'El Madher', nameAr: 'المعذر' }, { name: 'Fesdis', nameAr: 'فسديس' }, { name: 'Foum Toub', nameAr: 'فم الطوب' }, { name: 'Ghassira', nameAr: 'غسيرة' }, { name: 'Gosbat', nameAr: 'القصبات' }, { name: 'Guigba', nameAr: 'القيقبة' }, { name: 'Hidoussa', nameAr: 'حيدوسة' }, { name: 'Ichemoul', nameAr: 'إشمول' }, { name: 'Inoughissen', nameAr: 'إينوغيسن' }, { name: 'Kimmel', nameAr: 'كيمل' }, { name: 'Ksar Bellezma', nameAr: 'قصر بلزمة' }, { name: 'Larbaa', nameAr: 'لارباع' }, { name: 'Lazrou', nameAr: 'لازرو' }, { name: 'Lemcene', nameAr: 'لمسان' }, { name: 'M Doukal', nameAr: 'إمدوكل' }, { name: 'Maafa', nameAr: 'معافة' }, { name: 'Menaa', nameAr: 'منعة' }, { name: 'Merouana', nameAr: 'مروانة' }, { name: 'N Gaous', nameAr: 'نقاوس' }, { name: 'Oued Chaaba', nameAr: 'وادي الشعبة' }, { name: 'Oued El Ma', nameAr: 'وادي الماء' }, { name: 'Oued Taga', nameAr: 'وادي الطاقة' }, { name: 'Ouled Ammar', nameAr: 'أولاد عمار' }, { name: 'Ouled Aouf', nameAr: 'أولاد عوف' }, { name: 'Ouled Fadel', nameAr: 'أولاد فاضل' }, { name: 'Ouled Sellem', nameAr: 'أولاد سلام' }, { name: 'Ouled Si Slimane', nameAr: 'أولاد سي سليمان' }, { name: 'Ouyoun El Assafir', nameAr: 'عيون العصافير' }, { name: 'Rahbat', nameAr: 'الرحبات' }, { name: 'Ras El Aioun', nameAr: 'رأس العيون' }, { name: 'Sefiane', nameAr: 'سفيان' }, { name: 'Seggana', nameAr: 'سقانة' }, { name: 'Seriana', nameAr: 'سريانة' }, { name: 'T Kout', nameAr: 'تكوت' }, { name: 'Talkhamt', nameAr: 'تالخمت' }, { name: 'Taxlent', nameAr: 'تاكسلانت' }, { name: 'Tazoult', nameAr: 'تازولت' }, { name: 'Teniet El Abed', nameAr: 'ثنية العابد' }, { name: 'Tighanimine', nameAr: 'تيغانمين' }, { name: 'Tigharghar', nameAr: 'تغرغار' }, { name: 'Tilatou', nameAr: 'تيلاطو' }, { name: 'Timgad', nameAr: 'تيمقاد' }, { name: 'Zanet El Beida', nameAr: 'زانة البيضاء' },
    ],
  },
  {
    code: '06',
    name: 'Béjaïa',
    nameAr: ' بجاية',
    communes: [ { name: 'Adekar', nameAr: 'أدكار' }, { name: 'Ait R\'zine', nameAr: 'أيت رزين' }, { name: 'Ait-Smail', nameAr: 'أيت إسماعيل' }, { name: 'Akbou', nameAr: 'أقبو' }, { name: 'Akfadou', nameAr: 'أكفادو' }, { name: 'Amalou', nameAr: 'أمالو' }, { name: 'Amizour', nameAr: 'أميزور' }, { name: 'Aokas', nameAr: 'أوقاس' }, { name: 'Barbacha', nameAr: 'برباشة' }, { name: 'Bejaia', nameAr: 'بجاية' }, { name: 'Beni Djellil', nameAr: 'بني جليل' }, { name: 'Beni K\'sila', nameAr: 'بني كسيلة' }, { name: 'Beni-Mallikeche', nameAr: 'بني مليكش' }, { name: 'Benimaouche', nameAr: 'بني معوش' }, { name: 'Boudjellil', nameAr: 'بو جليل' }, { name: 'Bouhamza', nameAr: 'بوحمزة' }, { name: 'Boukhelifa', nameAr: 'بوخليفة' }, { name: 'Chellata', nameAr: 'شلاطة' }, { name: 'Chemini', nameAr: 'شميني' }, { name: 'Darguina', nameAr: 'درقينة' }, { name: 'Dra El Caid', nameAr: 'ذراع القايد' }, { name: 'El Kseur', nameAr: 'القصر' }, { name: 'Fenaia Il Maten', nameAr: 'فناية الماثن' }, { name: 'Feraoun', nameAr: 'فرعون' }, { name: 'Ighil-Ali', nameAr: 'إغيل علي' }, { name: 'Ighram', nameAr: 'اغرم' }, { name: 'Kendira', nameAr: 'كنديرة' }, { name: 'Kherrata', nameAr: 'خراطة' }, { name: 'Leflaye', nameAr: 'الفلاي' }, { name: 'M\'cisna', nameAr: 'مسيسنة' }, { name: 'Melbou', nameAr: 'مالبو' }, { name: 'Oued Ghir', nameAr: 'وادي غير' }, { name: 'Ouzellaguen', nameAr: 'أوزلاقن' }, { name: 'Seddouk', nameAr: 'صدوق' }, { name: 'Sidi Ayad', nameAr: 'سيدي عياد' }, { name: 'Sidi-Aich', nameAr: 'سيدي عيش' }, { name: 'Smaoun', nameAr: 'سمعون' }, { name: 'Souk El Tenine', nameAr: 'سوق لإثنين' }, { name: 'Souk Oufella', nameAr: 'سوق اوفلا' }, { name: 'Tala Hamza', nameAr: 'تالة حمزة' }, { name: 'Tamokra', nameAr: 'تامقرة' }, { name: 'Tamridjet', nameAr: 'تامريجت' }, { name: 'Taourit Ighil', nameAr: 'تاوريرت إغيل' }, { name: 'Taskriout', nameAr: 'تاسكريوت' }, { name: 'Tazmalt', nameAr: 'تازمالت' }, { name: 'Tibane', nameAr: 'طيبان' }, { name: 'Tichy', nameAr: 'تيشي' }, { name: 'Tifra', nameAr: 'تيفرة' }, { name: 'Timezrit', nameAr: 'تيمزريت' }, { name: 'Tinebdar', nameAr: 'تينبدار' }, { name: 'Tizi-N\'berber', nameAr: 'تيزي نبربر' }, { name: 'Toudja', nameAr: 'توجة' },
    ],
  },
  {
    code: '07',
    name: 'Biskra',
    nameAr: 'بسكرة',
    communes: [ { name: 'Ain Naga', nameAr: 'عين الناقة' }, { name: 'Ain Zaatout', nameAr: 'عين زعطوط' }, { name: 'Biskra', nameAr: 'بسكرة' }, { name: 'Bordj Ben Azzouz', nameAr: 'برج بن عزوز' }, { name: 'Bouchakroun', nameAr: 'بوشقرون' }, { name: 'Branis', nameAr: 'برانيس' }, { name: 'Chetma', nameAr: 'شتمة' }, { name: 'Djemorah', nameAr: 'جمورة' }, { name: 'El Feidh', nameAr: 'الفيض' }, { name: 'El Ghrous', nameAr: 'الغروس' }, { name: 'El Hadjab', nameAr: 'الحاجب' }, { name: 'El Haouch', nameAr: 'الحوش' }, { name: 'El Kantara', nameAr: 'القنطرة' }, { name: 'El Outaya', nameAr: 'الوطاية' }, { name: 'Foughala', nameAr: 'فوغالة' }, { name: 'Khenguet Sidi Nadji', nameAr: 'خنقة سيدي ناجي' }, { name: 'Lichana', nameAr: 'ليشانة' }, { name: 'Lioua', nameAr: 'ليوة' }, { name: 'M\'chouneche', nameAr: 'مشونش' }, { name: 'M\'lili', nameAr: 'مليلي' }, { name: 'Mekhadma', nameAr: 'مخادمة' }, { name: 'Meziraa', nameAr: 'المزيرعة' }, { name: 'Oumache', nameAr: 'أوماش' }, { name: 'Ourlal', nameAr: 'أورلال' }, { name: 'Sidi Okba', nameAr: 'سيدي عقبة' }, { name: 'Tolga', nameAr: 'طولقة' }, { name: 'Zeribet El Oued', nameAr: 'زريبة الوادي' },
    ],
  },
  {
    code: '08',
    name: 'Béchar',
    nameAr: 'بشار',
    communes: [ { name: 'Abadla', nameAr: 'العبادلة' }, { name: 'Bechar', nameAr: 'بشار' }, { name: 'Beni-Ounif', nameAr: 'بني ونيف' }, { name: 'Boukais', nameAr: 'بوكايس' }, { name: 'Erg-Ferradj', nameAr: 'عرق فراج' }, { name: 'Kenadsa', nameAr: 'القنادسة' }, { name: 'Lahmar', nameAr: 'لحمر' }, { name: 'Machraa-Houari-Boumediene', nameAr: 'مشرع هواري بومدين' }, { name: 'Meridja', nameAr: 'المريجة' }, { name: 'Mogheul', nameAr: 'موغل' }, { name: 'Tabelbala', nameAr: 'تبلبالة' }, { name: 'Taghit', nameAr: 'تاغيت' },
    ],
  },
  {
    code: '09',
    name: 'Blida',
    nameAr: 'البليدة',
    communes: [ { name: 'Ain Romana', nameAr: 'عين الرمانة' }, { name: 'Beni Mered', nameAr: 'بني مراد' }, { name: 'Beni-Tamou', nameAr: 'بني تامو' }, { name: 'Benkhelil', nameAr: 'بن خليل' }, { name: 'Blida', nameAr: 'البليدة' }, { name: 'Bouarfa', nameAr: 'بوعرفة' }, { name: 'Boufarik', nameAr: 'بوفاريك' }, { name: 'Bougara', nameAr: 'بوقرة' }, { name: 'Bouinan', nameAr: 'بوعينان' }, { name: 'Chebli', nameAr: 'الشبلي' }, { name: 'Chiffa', nameAr: 'الشفة' }, { name: 'Chrea', nameAr: 'الشريعة' }, { name: 'Djebabra', nameAr: 'جبابرة' }, { name: 'El-Affroun', nameAr: 'العفرون' }, { name: 'Guerrouaou', nameAr: 'قرواو' }, { name: 'Hammam Elouane', nameAr: 'حمام ملوان' }, { name: 'Larbaa', nameAr: 'الأربعاء' }, { name: 'Meftah', nameAr: 'مفتاح' }, { name: 'Mouzaia', nameAr: 'موزاية' }, { name: 'Oued  Djer', nameAr: 'وادي جر' }, { name: 'Oued El Alleug', nameAr: 'وادي العلايق' }, { name: 'Ouled Slama', nameAr: 'اولاد سلامة' }, { name: 'Ouled Yaich', nameAr: 'أولاد يعيش' }, { name: 'Souhane', nameAr: 'صوحان' }, { name: 'Soumaa', nameAr: 'الصومعة' },
    ],
  },
  {
    code: '10',
    name: 'Bouira',
    nameAr: 'البويرة',
    communes: [ { name: 'Aghbalou', nameAr: 'أغبالو' }, { name: 'Ahl El Ksar', nameAr: 'أهل القصر' }, { name: 'Ain El Hadjar', nameAr: 'عين الحجر' }, { name: 'Ain Laloui', nameAr: 'عين العلوي' }, { name: 'Ain Turk', nameAr: 'عين الترك' }, { name: 'Ain-Bessem', nameAr: 'عين بسام' }, { name: 'Ait Laaziz', nameAr: 'أيت لعزيز' }, { name: 'Aomar', nameAr: 'أعمر' }, { name: 'Ath Mansour', nameAr: 'آث  منصور' }, { name: 'Bechloul', nameAr: 'بشلول' }, { name: 'Bir Ghbalou', nameAr: 'بئر غبالو' }, { name: 'Bordj Okhriss', nameAr: 'برج أوخريص' }, { name: 'Bouderbala', nameAr: 'بودربالة' }, { name: 'Bouira', nameAr: 'البويرة' }, { name: 'Boukram', nameAr: 'بوكرم' }, { name: 'Chorfa', nameAr: 'شرفة' }, { name: 'Dechmia', nameAr: 'الدشمية' }, { name: 'Dirah', nameAr: 'ديرة' }, { name: 'Djebahia', nameAr: 'جباحية' }, { name: 'El Adjiba', nameAr: 'العجيبة' }, { name: 'El Asnam', nameAr: 'الأسنام' }, { name: 'El Hachimia', nameAr: 'الهاشمية' }, { name: 'El Khabouzia', nameAr: 'الخبوزية' }, { name: 'El-Hakimia', nameAr: 'الحاكمية' }, { name: 'El-Mokrani', nameAr: 'المقراني' }, { name: 'Guerrouma', nameAr: 'قرومة' }, { name: 'Hadjera Zerga', nameAr: 'الحجرة الزرقاء' }, { name: 'Haizer', nameAr: 'حيزر' }, { name: 'Hanif', nameAr: 'حنيف' }, { name: 'Kadiria', nameAr: 'قادرية' }, { name: 'Lakhdaria', nameAr: 'الأخضرية' }, { name: 'M Chedallah', nameAr: 'أمشدالة' }, { name: 'Maala', nameAr: 'معلة' }, { name: 'Maamora', nameAr: 'المعمورة' }, { name: 'Mezdour', nameAr: 'مزدور' }, { name: 'Oued El Berdi', nameAr: 'وادي البردي' }, { name: 'Ouled Rached', nameAr: 'أولاد راشد' }, { name: 'Raouraoua', nameAr: 'روراوة' }, { name: 'Ridane', nameAr: 'ريدان' }, { name: 'Saharidj', nameAr: 'سحاريج' }, { name: 'Souk El Khemis', nameAr: 'سوق الخميس' }, { name: 'Sour El Ghozlane', nameAr: 'سور الغزلان' }, { name: 'Taghzout', nameAr: 'تاغزوت' }, { name: 'Taguedite', nameAr: 'تاقديت' }, { name: 'Z\'barbar (El Isseri )', nameAr: 'زبربر' },
    ],
  },
  {
    code: '11',
    name: 'Tamanrasset',
    nameAr: 'تمنراست',
    communes: [ { name: 'Abelsa', nameAr: 'ابلسة' }, { name: 'Ain Amguel', nameAr: 'عين امقل' }, { name: 'Idles', nameAr: 'أدلس' }, { name: 'Tamanrasset', nameAr: 'تمنراست' }, { name: 'Tazrouk', nameAr: 'تاظروك' },
    ],
  },
  {
    code: '12',
    name: 'Tébessa',
    nameAr: 'تبسة',
    communes: [ { name: 'Ain Zerga', nameAr: 'عين الزرقاء' }, { name: 'Bedjene', nameAr: 'بجن' }, { name: 'Bekkaria', nameAr: 'بكارية' }, { name: 'Bir Dheheb', nameAr: 'بئر الذهب' }, { name: 'Bir Mokkadem', nameAr: 'بئر مقدم' }, { name: 'Bir-El-Ater', nameAr: 'بئر العاتر' }, { name: 'Boukhadra', nameAr: 'بوخضرة' }, { name: 'Boulhaf Dyr', nameAr: 'بولحاف الدير' }, { name: 'Cheria', nameAr: 'الشريعة' }, { name: 'El Kouif', nameAr: 'الكويف' }, { name: 'El Malabiod', nameAr: 'الماء الابيض' }, { name: 'El Meridj', nameAr: 'المريج' }, { name: 'El Mezeraa', nameAr: 'المزرعة' }, { name: 'El Ogla', nameAr: 'العقلة' }, { name: 'El Ogla El Malha', nameAr: 'العقلة المالحة' }, { name: 'El-Aouinet', nameAr: 'العوينات' }, { name: 'El-Houidjbet', nameAr: 'الحويجبات' }, { name: 'Ferkane', nameAr: 'فركان' }, { name: 'Guorriguer', nameAr: 'قريقر' }, { name: 'Hammamet', nameAr: 'الحمامات' }, { name: 'Morsott', nameAr: 'مرسط' }, { name: 'Negrine', nameAr: 'نقرين' }, { name: 'Ouenza', nameAr: 'الونزة' }, { name: 'Oum Ali', nameAr: 'أم علي' }, { name: 'Saf Saf El Ouesra', nameAr: 'صفصاف الوسرى' }, { name: 'Stah Guentis', nameAr: 'سطح قنطيس' }, { name: 'Tebessa', nameAr: 'تبسة' }, { name: 'Telidjen', nameAr: 'ثليجان' },
    ],
  },
  {
    code: '13',
    name: 'Tlemcen',
    nameAr: 'تلمسان',
    communes: [ { name: 'Ain Fetah', nameAr: 'عين فتاح' }, { name: 'Ain Fezza', nameAr: 'عين فزة' }, { name: 'Ain Ghoraba', nameAr: 'عين غرابة' }, { name: 'Ain Kebira', nameAr: 'عين الكبيرة' }, { name: 'Ain Nehala', nameAr: 'عين النحالة' }, { name: 'Ain Tellout', nameAr: 'عين تالوت' }, { name: 'Ain Youcef', nameAr: 'عين يوسف' }, { name: 'Amieur', nameAr: 'عمير' }, { name: 'Azail', nameAr: 'العزايل' }, { name: 'Bab El Assa', nameAr: 'باب العسة' }, { name: 'Beni Bahdel', nameAr: 'بني بهدل' }, { name: 'Beni Boussaid', nameAr: 'بني بوسعيد' }, { name: 'Beni Khellad', nameAr: 'بني خلاد' }, { name: 'Beni Mester', nameAr: 'بني مستر' }, { name: 'Beni Ouarsous', nameAr: 'بني وارسوس' }, { name: 'Beni Smiel', nameAr: 'بني صميل' }, { name: 'Beni Snous', nameAr: 'بني سنوس' }, { name: 'Bensekrane', nameAr: 'بن سكران' }, { name: 'Bouhlou', nameAr: 'بوحلو' }, { name: 'Bouihi', nameAr: 'البويهي' }, { name: 'Chetouane', nameAr: 'شتوان' }, { name: 'Dar Yaghmoracen', nameAr: 'دار يغمراسن' }, { name: 'Djebala', nameAr: 'جبالة' }, { name: 'El Aricha', nameAr: 'العريشة' }, { name: 'El Fehoul', nameAr: 'الفحول' }, { name: 'El Gor', nameAr: 'القور' }, { name: 'Fellaoucene', nameAr: 'فلاوسن' }, { name: 'Ghazaouet', nameAr: 'الغزوات' }, { name: 'Hammam Boughrara', nameAr: 'حمام بوغرارة' }, { name: 'Hennaya', nameAr: 'الحناية' }, { name: 'Honnaine', nameAr: 'هنين' }, { name: 'M\'sirda Fouaga', nameAr: 'مسيردة الفواقة' }, { name: 'Maghnia', nameAr: 'مغنية' }, { name: 'Mansourah', nameAr: 'منصورة' }, { name: 'Marsa Ben M\'hidi', nameAr: 'مرسى بن مهيدي' }, { name: 'Nedroma', nameAr: 'ندرومة' }, { name: 'Oued Lakhdar', nameAr: 'وادي الخضر' }, { name: 'Ouled Mimoun', nameAr: 'أولاد ميمون' }, { name: 'Ouled Riyah', nameAr: 'أولاد رياح' }, { name: 'Remchi', nameAr: 'الرمشي' }, { name: 'Sabra', nameAr: 'صبرة' }, { name: 'Sebbaa Chioukh', nameAr: 'سبعة شيوخ' }, { name: 'Sebdou', nameAr: 'سبدو' }, { name: 'Sidi Abdelli', nameAr: 'سيدي العبدلي' }, { name: 'Sidi Djillali', nameAr: 'سيدي الجيلالي' }, { name: 'Sidi Medjahed', nameAr: 'سيدي مجاهد' }, { name: 'Souahlia', nameAr: 'السواحلية' }, { name: 'Souani', nameAr: 'السواني' }, { name: 'Souk Tleta', nameAr: 'سوق الثلاثاء' }, { name: 'Terny Beni Hediel', nameAr: 'تيرني بني هديل' }, { name: 'Tianet', nameAr: 'تيانت' }, { name: 'Tlemcen', nameAr: 'تلمسان' }, { name: 'Zenata', nameAr: 'زناتة' },
    ],
  },
  {
    code: '14',
    name: 'Tiaret',
    nameAr: 'تيارت',
    communes: [ { name: 'Ain Bouchekif', nameAr: 'عين بوشقيف' }, { name: 'Ain Deheb', nameAr: 'عين الذهب' }, { name: 'Ain Dzarit', nameAr: 'عين دزاريت' }, { name: 'Ain El Hadid', nameAr: 'عين الحديد' }, { name: 'Ain Kermes', nameAr: 'عين كرمس' }, { name: 'Bougara', nameAr: 'بوقرة' }, { name: 'Chehaima', nameAr: 'شحيمة' }, { name: 'Dahmouni', nameAr: 'دحموني' }, { name: 'Djebilet Rosfa', nameAr: 'جبيلات الرصفاء' }, { name: 'Djillali Ben Amar', nameAr: 'جيلالي بن عمار' }, { name: 'Faidja', nameAr: 'الفايجة' }, { name: 'Frenda', nameAr: 'فرندة' }, { name: 'Guertoufa', nameAr: 'قرطوفة' }, { name: 'Hamadia', nameAr: 'حمادية' }, { name: 'Ksar Chellala', nameAr: 'قصر الشلالة' }, { name: 'Madna', nameAr: 'مادنة' }, { name: 'Mahdia', nameAr: 'مهدية' }, { name: 'Mechraa Safa', nameAr: 'مشرع الصفا' }, { name: 'Medrissa', nameAr: 'مدريسة' }, { name: 'Medroussa', nameAr: 'مدروسة' }, { name: 'Meghila', nameAr: 'مغيلة' }, { name: 'Mellakou', nameAr: 'ملاكو' }, { name: 'Nadorah', nameAr: 'الناظورة' }, { name: 'Naima', nameAr: 'النعيمة' }, { name: 'Oued Lilli', nameAr: 'وادي ليلي' }, { name: 'Rahouia', nameAr: 'الرحوية' }, { name: 'Rechaiga', nameAr: 'الرشايقة' }, { name: 'Sebaine', nameAr: 'السبعين' }, { name: 'Sebt', nameAr: 'السبت' }, { name: 'Serghine', nameAr: 'سرغين' }, { name: 'Si Abdelghani', nameAr: 'سي عبد الغني' }, { name: 'Sidi Abderrahmane', nameAr: 'سيدي عبد الرحمن' }, { name: 'Sidi Ali Mellal', nameAr: 'سيدي علي ملال' }, { name: 'Sidi Bakhti', nameAr: 'سيدي بختي' }, { name: 'Sidi Hosni', nameAr: 'سيدي حسني' }, { name: 'Sougueur', nameAr: 'السوقر' }, { name: 'Tagdempt', nameAr: 'تاقدمت' }, { name: 'Takhemaret', nameAr: 'تخمرت' }, { name: 'Tiaret', nameAr: 'تيارت' }, { name: 'Tidda', nameAr: 'تيدة' }, { name: 'Tousnina', nameAr: 'توسنينة' }, { name: 'Zmalet El Emir Abdelkade', nameAr: 'زمالة  الأمير عبد القادر' },
    ],
  },
  {
    code: '15',
    name: 'Tizi Ouzou',
    nameAr: 'تيزي وزو',
    communes: [ { name: 'Abi-Youcef', nameAr: 'أبي يوسف' }, { name: 'Aghribs', nameAr: 'أغريب' }, { name: 'Agouni-Gueghrane', nameAr: 'أقني قغران' }, { name: 'Ain-El-Hammam', nameAr: 'عين الحمام' }, { name: 'Ain-Zaouia', nameAr: 'عين الزاوية' }, { name: 'Ait Aggouacha', nameAr: 'أيت عقـواشة' }, { name: 'Ait Bouaddou', nameAr: 'أيت بــوادو' }, { name: 'Ait Boumahdi', nameAr: 'أيت بومهدي' }, { name: 'Ait Khellili', nameAr: 'أيت خليلي' }, { name: 'Ait Yahia Moussa', nameAr: 'أيت يحي موسى' }, { name: 'Ait-Aissa-Mimoun', nameAr: 'أيت عيسى ميمون' }, { name: 'Ait-Chafaa', nameAr: 'أيت شافع' }, { name: 'Ait-Mahmoud', nameAr: 'أيت محمود' }, { name: 'Ait-Oumalou', nameAr: 'أيت  أومالو' }, { name: 'Ait-Toudert', nameAr: 'أيت تودرت' }, { name: 'Ait-Yahia', nameAr: 'أيت يحيى' }, { name: 'Akbil', nameAr: 'اقبيل' }, { name: 'Akerrou', nameAr: 'أقرو' }, { name: 'Assi-Youcef', nameAr: 'أسي يوسف' }, { name: 'Azazga', nameAr: 'عزازقة' }, { name: 'Azeffoun', nameAr: 'أزفون' }, { name: 'Beni Zmenzer', nameAr: 'بنــــي زمنزار' }, { name: 'Beni-Aissi', nameAr: 'بني عيسي' }, { name: 'Beni-Douala', nameAr: 'بني دوالة' }, { name: 'Beni-Yenni', nameAr: 'بني يني' }, { name: 'Beni-Zikki', nameAr: 'بني زيكــي' }, { name: 'Boghni', nameAr: 'بوغني' }, { name: 'Boudjima', nameAr: 'بوجيمة' }, { name: 'Bounouh', nameAr: 'بونوح' }, { name: 'Bouzeguene', nameAr: 'بوزقــن' }, { name: 'Draa-Ben-Khedda', nameAr: 'ذراع بن خدة' }, { name: 'Draa-El-Mizan', nameAr: 'ذراع الميزان' }, { name: 'Freha', nameAr: 'فريحة' }, { name: 'Frikat', nameAr: 'فريقات' }, { name: 'Iboudrarene', nameAr: 'إبودرارن' }, { name: 'Idjeur', nameAr: 'إيجــار' }, { name: 'Iferhounene', nameAr: 'إفــرحــونان' }, { name: 'Ifigha', nameAr: 'إيفيغاء' }, { name: 'Iflissen', nameAr: 'إفليـــسن' }, { name: 'Illilten', nameAr: 'إيلـيــلتـن' }, { name: 'Illoula Oumalou', nameAr: 'إيلولة أومـــالو' }, { name: 'Imsouhal', nameAr: 'إمســوحال' }, { name: 'Irdjen', nameAr: 'إيرجـــن' }, { name: 'Larbaa Nath Irathen', nameAr: 'الأربعــاء ناث إيراثن' }, { name: 'M\'kira', nameAr: 'مكيرة' }, { name: 'Maatkas', nameAr: 'معـــاتقة' }, { name: 'Makouda', nameAr: 'ماكودة' }, { name: 'Mechtras', nameAr: 'مشطراس' }, { name: 'Mekla', nameAr: 'مقــلع' }, { name: 'Mizrana', nameAr: 'ميزرانـــة' }, { name: 'Ouacif', nameAr: 'واسيف' }, { name: 'Ouadhias', nameAr: 'واضية' }, { name: 'Ouaguenoun', nameAr: 'واقنون' }, { name: 'Sidi Namane', nameAr: 'سيدي نعمان' }, { name: 'Souama', nameAr: 'صوامـــع' }, { name: 'Souk-El-Tenine', nameAr: 'سوق الإثنين' }, { name: 'Tadmait', nameAr: 'تادمايت' }, { name: 'Tigzirt', nameAr: 'تيقـزيرت' }, { name: 'Timizart', nameAr: 'تيمـيزار' }, { name: 'Tirmitine', nameAr: 'تيرمتين' }, { name: 'Tizi N\'tleta', nameAr: 'تيزي نثلاثة' }, { name: 'Tizi-Gheniff', nameAr: 'تيزي غنيف' }, { name: 'Tizi-Ouzou', nameAr: 'تيزي وزو' }, { name: 'Tizi-Rached', nameAr: 'تيزي راشد' }, { name: 'Yakourene', nameAr: 'إعــكورن' }, { name: 'Yatafene', nameAr: 'يطــافن' }, { name: 'Zekri', nameAr: 'زكري' },
    ],
  },
  {
    code: '16',
    name: 'Alger',
    nameAr: 'الجزائر',
    communes: [ { name: 'Ain Benian', nameAr: 'عين بنيان' }, { name: 'Ain Taya', nameAr: 'عين طاية' }, { name: 'Alger Centre', nameAr: 'الجزائر الوسطى' }, { name: 'Bab El Oued', nameAr: 'باب الوادي' }, { name: 'Bab Ezzouar', nameAr: 'باب الزوار' }, { name: 'Baba Hassen', nameAr: 'بابا حسن' }, { name: 'Bachedjerah', nameAr: 'باش جراح' }, { name: 'Baraki', nameAr: 'براقي' }, { name: 'Ben Aknoun', nameAr: 'ابن عكنون' }, { name: 'Beni Messous', nameAr: 'بني مسوس' }, { name: 'Bir Mourad Rais', nameAr: 'بئر مراد رايس' }, { name: 'Bir Touta', nameAr: 'بئر توتة' }, { name: 'Birkhadem', nameAr: 'بئر خادم' }, { name: 'Bologhine Ibnou Ziri', nameAr: 'بولوغين بن زيري' }, { name: 'Bordj El Bahri', nameAr: 'برج البحري' }, { name: 'Bordj El Kiffan', nameAr: 'برج الكيفان' }, { name: 'Bourouba', nameAr: 'بوروبة' }, { name: 'Bouzareah', nameAr: 'بوزريعة' }, { name: 'Casbah', nameAr: 'القصبة' }, { name: 'Cheraga', nameAr: 'الشراقة' }, { name: 'Dar El Beida', nameAr: 'الدار البيضاء' }, { name: 'Dely Ibrahim', nameAr: 'دالي ابراهيم' }, { name: 'Djasr Kasentina', nameAr: 'جسر قسنطينة' }, { name: 'Douira', nameAr: 'الدويرة' }, { name: 'Draria', nameAr: 'الدرارية' }, { name: 'El Achour', nameAr: 'العاشور' }, { name: 'El Biar', nameAr: 'الابيار' }, { name: 'El Harrach', nameAr: 'الحراش' }, { name: 'El Madania', nameAr: 'المدنية' }, { name: 'El Magharia', nameAr: 'المغارية' }, { name: 'El Marsa', nameAr: 'المرسى' }, { name: 'El Mouradia', nameAr: 'المرادية' }, { name: 'Hammamet', nameAr: 'الحمامات' }, { name: 'Herraoua', nameAr: 'هراوة' }, { name: 'Hussein Dey', nameAr: 'حسين داي' }, { name: 'Hydra', nameAr: 'حيدرة' }, { name: 'Khraissia', nameAr: 'الخرايسية' }, { name: 'Kouba', nameAr: 'القبة' }, { name: 'Les Eucalyptus', nameAr: 'الكاليتوس' }, { name: 'Maalma', nameAr: 'المعالمة' }, { name: 'Mohamed Belouzdad', nameAr: 'محمد بلوزداد' }, { name: 'Mohammadia', nameAr: 'المحمدية' }, { name: 'Oued Koriche', nameAr: 'وادي قريش' }, { name: 'Oued Smar', nameAr: 'وادي السمار' }, { name: 'Ouled Chebel', nameAr: 'اولاد شبل' }, { name: 'Ouled Fayet', nameAr: 'اولاد فايت' }, { name: 'Rahmania', nameAr: 'الرحمانية' }, { name: 'Rais Hamidou', nameAr: 'الرايس حميدو' }, { name: 'Reghaia', nameAr: 'رغاية' }, { name: 'Rouiba', nameAr: 'الرويبة' }, { name: 'Sehaoula', nameAr: 'السحاولة' }, { name: 'Sidi M\'hamed', nameAr: 'سيدي امحمد' }, { name: 'Sidi Moussa', nameAr: 'سيدي موسى' }, { name: 'Souidania', nameAr: 'سويدانية' }, { name: 'Staoueli', nameAr: 'سطاوالي' }, { name: 'Tessala El Merdja', nameAr: 'تسالة المرجة' }, { name: 'Zeralda', nameAr: 'زرالدة' },
    ],
  },
  {
    code: '17',
    name: 'Djelfa',
    nameAr: 'الجلفة',
    communes: [ { name: 'Ain Chouhada', nameAr: 'عين الشهداء' }, { name: 'Ain El Ibel', nameAr: 'عين الإبل' }, { name: 'Ain Fekka', nameAr: 'عين فقه' }, { name: 'Ain Maabed', nameAr: 'عين معبد' }, { name: 'Ain Oussera', nameAr: 'عين وسارة' }, { name: 'Amourah', nameAr: 'عمورة' }, { name: 'Benhar', nameAr: 'بنهار' }, { name: 'Benyagoub', nameAr: 'بن يعقوب' }, { name: 'Birine', nameAr: 'بيرين' }, { name: 'Bouira Lahdab', nameAr: 'بويرة الأحداب' }, { name: 'Charef', nameAr: 'الشارف' }, { name: 'Dar Chioukh', nameAr: 'دار الشيوخ' }, { name: 'Deldoul', nameAr: 'دلدول' }, { name: 'Djelfa', nameAr: 'الجلفة' }, { name: 'Douis', nameAr: 'دويس' }, { name: 'El Guedid', nameAr: 'القديد' }, { name: 'El Idrissia', nameAr: 'الادريسية' }, { name: 'El Khemis', nameAr: 'الخميس' }, { name: 'Faidh El Botma', nameAr: 'فيض البطمة' }, { name: 'Guernini', nameAr: 'قرنيني' }, { name: 'Guettara', nameAr: 'قطارة' }, { name: 'Had Sahary', nameAr: 'حد الصحاري' }, { name: 'Hassi Bahbah', nameAr: 'حاسي بحبح' }, { name: 'Hassi El Euch', nameAr: 'حاسي العش' }, { name: 'Hassi Fedoul', nameAr: 'حاسي فدول' }, { name: 'M\'liliha', nameAr: 'مليليحة' }, { name: 'Messaad', nameAr: 'مسعد' }, { name: 'Moudjebara', nameAr: 'مجبارة' }, { name: 'Oum Laadham', nameAr: 'أم العظام' }, { name: 'Sed Rahal', nameAr: 'سد الرحال' }, { name: 'Selmana', nameAr: 'سلمانة' }, { name: 'Sidi Baizid', nameAr: 'سيدي بايزيد' }, { name: 'Sidi Laadjel', nameAr: 'سيدي لعجال' }, { name: 'Taadmit', nameAr: 'تعظميت' }, { name: 'Zaafrane', nameAr: 'زعفران' }, { name: 'Zaccar', nameAr: 'زكار' },
    ],
  },
  {
    code: '18',
    name: 'Jijel',
    nameAr: 'جيجل',
    communes: [ { name: 'Bordj T\'har', nameAr: 'برج الطهر' }, { name: 'Boudria Beniyadjis', nameAr: 'بودريعة بني  ياجيس' }, { name: 'Bouraoui Belhadef', nameAr: 'بوراوي بلهادف' }, { name: 'Boussif Ouled Askeur', nameAr: 'بوسيف أولاد عسكر' }, { name: 'Chahna', nameAr: 'الشحنة' }, { name: 'Chekfa', nameAr: 'الشقفة' }, { name: 'Djemaa Beni Habibi', nameAr: 'الجمعة بني حبيبي' }, { name: 'Djimla', nameAr: 'جيملة' }, { name: 'El Ancer', nameAr: 'العنصر' }, { name: 'El Aouana', nameAr: 'العوانة' }, { name: 'El Kennar Nouchfi', nameAr: 'القنار نشفي' }, { name: 'El Milia', nameAr: 'الميلية' }, { name: 'Emir Abdelkader', nameAr: 'الامير عبد القادر' }, { name: 'Erraguene Souissi', nameAr: 'أراقن سويسي' }, { name: 'Ghebala', nameAr: 'غبالة' }, { name: 'Jijel', nameAr: 'جيجل' }, { name: 'Kaous', nameAr: 'قاوس' }, { name: 'Khiri Oued Adjoul', nameAr: 'خيري واد عجول' }, { name: 'Oudjana', nameAr: 'وجانة' }, { name: 'Ouled Rabah', nameAr: 'أولاد رابح' }, { name: 'Ouled Yahia Khadrouch', nameAr: 'أولاد يحيى خدروش' }, { name: 'Selma Benziada', nameAr: 'سلمى بن زيادة' }, { name: 'Settara', nameAr: 'السطارة' }, { name: 'Sidi Abdelaziz', nameAr: 'سيدي عبد العزيز' }, { name: 'Sidi Marouf', nameAr: 'سيدي معروف' }, { name: 'Taher', nameAr: 'الطاهير' }, { name: 'Texenna', nameAr: 'تاكسنة' }, { name: 'Ziama Mansouriah', nameAr: 'زيامة منصورية' },
    ],
  },
  {
    code: '19',
    name: 'Sétif',
    nameAr: 'سطيف',
    communes: [ { name: 'Ain Abessa', nameAr: 'عين عباسة' }, { name: 'Ain Arnat', nameAr: 'عين أرنات' }, { name: 'Ain Azel', nameAr: 'عين أزال' }, { name: 'Ain El Kebira', nameAr: 'عين الكبيرة' }, { name: 'Ain Lahdjar', nameAr: 'عين الحجر' }, { name: 'Ain Oulmene', nameAr: 'عين ولمان' }, { name: 'Ain-Legradj', nameAr: 'عين لقراج' }, { name: 'Ain-Roua', nameAr: 'عين الروى' }, { name: 'Ain-Sebt', nameAr: 'عين السبت' }, { name: 'Ait Naoual Mezada', nameAr: 'أيت نوال مزادة' }, { name: 'Ait-Tizi', nameAr: 'ايت تيزي' }, { name: 'Amoucha', nameAr: 'عموشة' }, { name: 'Babor', nameAr: 'بابور' }, { name: 'Bazer-Sakra', nameAr: 'بازر سكرة' }, { name: 'Beidha Bordj', nameAr: 'بيضاء برج' }, { name: 'Bellaa', nameAr: 'بلاعة' }, { name: 'Beni Chebana', nameAr: 'بني شبانة' }, { name: 'Beni Fouda', nameAr: 'بني فودة' }, { name: 'Beni Ourtilane', nameAr: 'بني ورتيلان' }, { name: 'Beni Oussine', nameAr: 'بني وسين' }, { name: 'Beni-Aziz', nameAr: 'بني عزيز' }, { name: 'Beni-Mouhli', nameAr: 'بني موحلي' }, { name: 'Bir Haddada', nameAr: 'بئر حدادة' }, { name: 'Bir-El-Arch', nameAr: 'بئر العرش' }, { name: 'Bouandas', nameAr: 'بوعنداس' }, { name: 'Bougaa', nameAr: 'بوقاعة' }, { name: 'Bousselam', nameAr: 'بوسلام' }, { name: 'Boutaleb', nameAr: 'بوطالب' }, { name: 'Dehamcha', nameAr: 'الدهامشة' }, { name: 'Djemila', nameAr: 'جميلة' }, { name: 'Draa-Kebila', nameAr: 'ذراع قبيلة' }, { name: 'El Eulma', nameAr: 'العلمة' }, { name: 'El Ouricia', nameAr: 'أوريسيا' }, { name: 'El-Ouldja', nameAr: 'الولجة' }, { name: 'Guellal', nameAr: 'قلال' }, { name: 'Guelta Zerka', nameAr: 'قلتة زرقاء' }, { name: 'Guenzet', nameAr: 'قنزات' }, { name: 'Guidjel', nameAr: 'قجال' }, { name: 'Hamam Soukhna', nameAr: 'حمام السخنة' }, { name: 'Hamma', nameAr: 'الحامة' }, { name: 'Hammam Guergour', nameAr: 'حمام قرقور' }, { name: 'Harbil', nameAr: 'حربيل' }, { name: 'Kasr El Abtal', nameAr: 'قصر الابطال' }, { name: 'Maaouia', nameAr: 'معاوية' }, { name: 'Maouaklane', nameAr: 'ماوكلان' }, { name: 'Mezloug', nameAr: 'مزلوق' }, { name: 'Oued El Bared', nameAr: 'واد البارد' }, { name: 'Ouled Addouane', nameAr: 'أولاد عدوان' }, { name: 'Ouled Sabor', nameAr: 'أولاد صابر' }, { name: 'Ouled Si Ahmed', nameAr: 'أولاد سي أحمد' }, { name: 'Ouled Tebben', nameAr: 'أولاد تبان' }, { name: 'Rosfa', nameAr: 'الرصفة' }, { name: 'Salah Bey', nameAr: 'صالح باي' }, { name: 'Serdj-El-Ghoul', nameAr: 'سرج الغول' }, { name: 'Setif', nameAr: 'سطيف' }, { name: 'Tachouda', nameAr: 'تاشودة' }, { name: 'Tala-Ifacene', nameAr: 'تالة إيفاسن' }, { name: 'Taya', nameAr: 'الطاية' }, { name: 'Tella', nameAr: 'التلة' }, { name: 'Tizi N\'bechar', nameAr: 'تيزي نبشار' },
    ],
  },
  {
    code: '20',
    name: 'Saïda',
    nameAr: 'سعيدة',
    communes: [ { name: 'Ain El Hadjar', nameAr: 'عين الحجر' }, { name: 'Ain Sekhouna', nameAr: 'عين السخونة' }, { name: 'Ain Soltane', nameAr: 'عين السلطان' }, { name: 'Doui Thabet', nameAr: 'دوي ثابت' }, { name: 'El Hassasna', nameAr: 'الحساسنة' }, { name: 'Hounet', nameAr: 'هونت' }, { name: 'Maamora', nameAr: 'المعمورة' }, { name: 'Moulay Larbi', nameAr: 'مولاي العربي' }, { name: 'Ouled Brahim', nameAr: 'أولاد إبراهيم' }, { name: 'Ouled Khaled', nameAr: 'أولاد خالد' }, { name: 'Saida', nameAr: 'سعيدة' }, { name: 'Sidi Ahmed', nameAr: 'سيدي احمد' }, { name: 'Sidi Amar', nameAr: 'سيدي عمر' }, { name: 'Sidi Boubekeur', nameAr: 'سيدي بوبكر' }, { name: 'Tircine', nameAr: 'تيرسين' }, { name: 'Youb', nameAr: 'يوب' },
    ],
  },
  {
    code: '21',
    name: 'Skikda',
    nameAr: 'سكيكدة',
    communes: [ { name: 'Ain Bouziane', nameAr: 'عين بوزيان' }, { name: 'Ain Charchar', nameAr: 'عين شرشار' }, { name: 'Ain Kechra', nameAr: 'عين قشرة' }, { name: 'Ain Zouit', nameAr: 'عين زويت' }, { name: 'Azzaba', nameAr: 'عزابة' }, { name: 'Bekkouche Lakhdar', nameAr: 'بكوش لخضر' }, { name: 'Ben Azzouz', nameAr: 'بن عزوز' }, { name: 'Beni Bechir', nameAr: 'بني بشير' }, { name: 'Beni Oulbane', nameAr: 'بني ولبان' }, { name: 'Beni Zid', nameAr: 'بني زيد' }, { name: 'Bin El Ouiden', nameAr: 'بين الويدان' }, { name: 'Bouchetata', nameAr: 'بوشطاطة' }, { name: 'Cheraia', nameAr: 'الشرايع' }, { name: 'Collo', nameAr: 'القل' }, { name: 'Djendel Saadi Mohamed', nameAr: 'جندل سعدي محمد' }, { name: 'El Arrouch', nameAr: 'الحروش' }, { name: 'El Ghedir', nameAr: 'الغدير' }, { name: 'El Hadaiek', nameAr: 'الحدائق' }, { name: 'El Marsa', nameAr: 'المرسى' }, { name: 'Emjez Edchich', nameAr: 'مجاز الدشيش' }, { name: 'Es Sebt', nameAr: 'السبت' }, { name: 'Filfila', nameAr: 'فلفلة' }, { name: 'Hammadi Krouma', nameAr: 'حمادي كرومة' }, { name: 'Kanoua', nameAr: 'قنواع' }, { name: 'Kerkara', nameAr: 'الكركرة' }, { name: 'Khenag Maoune', nameAr: 'خناق مايو' }, { name: 'Oued Zhour', nameAr: 'وادي الزهور' }, { name: 'Ouldja Boulbalout', nameAr: 'الولجة بولبلوط' }, { name: 'Ouled Attia', nameAr: 'أولاد عطية' }, { name: 'Ouled Habbaba', nameAr: 'أولاد حبابة' }, { name: 'Oum Toub', nameAr: 'أم الطوب' }, { name: 'Ramdane Djamel', nameAr: 'رمضان جمال' }, { name: 'Salah Bouchaour', nameAr: 'صالح بو الشعور' }, { name: 'Sidi Mezghiche', nameAr: 'سيدي مزغيش' }, { name: 'Skikda', nameAr: 'سكيكدة' }, { name: 'Tamalous', nameAr: 'تمالوس' }, { name: 'Zerdezas', nameAr: 'زردازة' }, { name: 'Zitouna', nameAr: 'الزيتونة' },
    ],
  },
  {
    code: '22',
    name: 'Sidi Bel Abbès',
    nameAr: 'سيدي بلعباس',
    communes: [ { name: 'Ain El Berd', nameAr: 'عين البرد' }, { name: 'Ain Kada', nameAr: 'عين قادة' }, { name: 'Ain Thrid', nameAr: 'عين الثريد' }, { name: 'Ain Tindamine', nameAr: 'عين تندمين' }, { name: 'Ain- Adden', nameAr: 'عين أدن' }, { name: 'Amarnas', nameAr: 'العمارنة' }, { name: 'Bedrabine El Mokrani', nameAr: 'بضرابين المقراني' }, { name: 'Belarbi', nameAr: 'بلعربي' }, { name: 'Ben Badis', nameAr: 'بن باديس' }, { name: 'Benachiba Chelia', nameAr: 'بن عشيبة شلية' }, { name: 'Bir El Hammam', nameAr: 'بئر الحمام' }, { name: 'Boudjebaa El Bordj', nameAr: 'بوجبهة البرج' }, { name: 'Boukhanefis', nameAr: 'بوخنفيس' }, { name: 'Chetouane Belaila', nameAr: 'شيطوان البلايلة' }, { name: 'Dhaya', nameAr: 'الضاية' }, { name: 'El Hacaiba', nameAr: 'الحصيبة' }, { name: 'Hassi Dahou', nameAr: 'حاسي دحو' }, { name: 'Hassi Zahana', nameAr: 'حاسي زهانة' }, { name: 'Lamtar', nameAr: 'لمطار' }, { name: 'M\'cid', nameAr: 'مسيد' }, { name: 'Makedra', nameAr: 'مكدرة' }, { name: 'Marhoum', nameAr: 'مرحوم' }, { name: 'Merine', nameAr: 'مرين' }, { name: 'Mezaourou', nameAr: 'مزاورو' }, { name: 'Mostefa  Ben Brahim', nameAr: 'مصطفى بن ابراهيم' }, { name: 'Moulay Slissen', nameAr: 'مولاي سليسن' }, { name: 'Oued Sebaa', nameAr: 'وادي السبع' }, { name: 'Oued Sefioun', nameAr: 'وادي سفيون' }, { name: 'Oued Taourira', nameAr: 'وادي تاوريرة' }, { name: 'Ras El Ma', nameAr: 'راس الماء' }, { name: 'Redjem Demouche', nameAr: 'رجم دموش' }, { name: 'Sehala Thaoura', nameAr: 'السهالة الثورة' }, { name: 'Sfisef', nameAr: 'سفيزف' }, { name: 'Sidi Ali Benyoub', nameAr: 'سيدي علي بن يوب' }, { name: 'Sidi Ali Boussidi', nameAr: 'سيدي علي بوسيدي' }, { name: 'Sidi Bel-Abbes', nameAr: 'سيدي بلعباس' }, { name: 'Sidi Brahim', nameAr: 'سيدي ابراهيم' }, { name: 'Sidi Chaib', nameAr: 'سيدي شعيب' }, { name: 'Sidi Dahou Zairs', nameAr: 'سيدي دحو الزاير' }, { name: 'Sidi Hamadouche', nameAr: 'سيدي حمادوش' }, { name: 'Sidi Khaled', nameAr: 'سيدي خالد' }, { name: 'Sidi Lahcene', nameAr: 'سيدي لحسن' }, { name: 'Sidi Yacoub', nameAr: 'سيدي يعقوب' }, { name: 'Tabia', nameAr: 'طابية' }, { name: 'Taoudmout', nameAr: 'تاودموت' }, { name: 'Tefessour', nameAr: 'تفسور' }, { name: 'Teghalimet', nameAr: 'تغاليمت' }, { name: 'Telagh', nameAr: 'تلاغ' }, { name: 'Tenira', nameAr: 'تنيرة' }, { name: 'Tessala', nameAr: 'تسالة' }, { name: 'Tilmouni', nameAr: 'تلموني' }, { name: 'Zerouala', nameAr: 'زروالة' },
    ],
  },
  {
    code: '23',
    name: 'Annaba',
    nameAr: 'عنابة',
    communes: [ { name: 'Ain El Berda', nameAr: 'عين الباردة' }, { name: 'Annaba', nameAr: 'عنابة' }, { name: 'Berrahal', nameAr: 'برحال' }, { name: 'Chetaibi', nameAr: 'شطايبي' }, { name: 'Cheurfa', nameAr: 'الشرفة' }, { name: 'El Bouni', nameAr: 'البوني' }, { name: 'El Eulma', nameAr: 'العلمة' }, { name: 'El Hadjar', nameAr: 'الحجار' }, { name: 'Oued El Aneb', nameAr: 'واد العنب' }, { name: 'Seraidi', nameAr: 'سرايدي' }, { name: 'Sidi Amar', nameAr: 'سيدي عمار' }, { name: 'Treat', nameAr: 'التريعات' },
    ],
  },
  {
    code: '24',
    name: 'Guelma',
    nameAr: 'قالمة',
    communes: [ { name: 'Ain Ben Beida', nameAr: 'عين بن بيضاء' }, { name: 'Ain Larbi', nameAr: 'عين العربي' }, { name: 'Ain Makhlouf', nameAr: 'عين مخلوف' }, { name: 'Ain Regada', nameAr: 'عين رقادة' }, { name: 'Ain Sandel', nameAr: 'عين صندل' }, { name: 'Belkheir', nameAr: 'بلخير' }, { name: 'Bendjarah', nameAr: 'بن جراح' }, { name: 'Beni Mezline', nameAr: 'بني مزلين' }, { name: 'Bordj Sabath', nameAr: 'برج صباط' }, { name: 'Bou Hachana', nameAr: 'بوحشانة' }, { name: 'Bou Hamdane', nameAr: 'بوحمدان' }, { name: 'Bouati Mahmoud', nameAr: 'بوعاتي محمود' }, { name: 'Bouchegouf', nameAr: 'بوشقوف' }, { name: 'Boumahra Ahmed', nameAr: 'بومهرة أحمد' }, { name: 'Dahouara', nameAr: 'الدهوارة' }, { name: 'Djeballah Khemissi', nameAr: 'جبالة الخميسي' }, { name: 'El Fedjoudj', nameAr: 'الفجوج' }, { name: 'Guelaat Bou Sbaa', nameAr: 'قلعة بوصبع' }, { name: 'Guelma', nameAr: 'قالمة' }, { name: 'Hammam Debagh', nameAr: 'حمام دباغ' }, { name: 'Hammam N\'bail', nameAr: 'حمام النبايل' }, { name: 'Heliopolis', nameAr: 'هيليوبوليس' }, { name: 'Houari Boumedienne', nameAr: 'هواري بومدين' }, { name: 'Khezaras', nameAr: 'لخزارة' }, { name: 'Medjez Amar', nameAr: 'مجاز عمار' }, { name: 'Medjez Sfa', nameAr: 'مجاز الصفاء' }, { name: 'Nechmaya', nameAr: 'نشماية' }, { name: 'Oued Cheham', nameAr: 'وادي الشحم' }, { name: 'Oued Ferragha', nameAr: 'وادي فراغة' }, { name: 'Oued Zenati', nameAr: 'وادي الزناتي' }, { name: 'Ras El Agba', nameAr: 'رأس العقبة' }, { name: 'Roknia', nameAr: 'الركنية' }, { name: 'Sellaoua Announa', nameAr: 'سلاوة عنونة' }, { name: 'Tamlouka', nameAr: 'تاملوكة' },
    ],
  },
  {
    code: '25',
    name: 'Constantine',
    nameAr: 'قسنطينة',
    communes: [ { name: 'Ain Abid', nameAr: 'عين عبيد' }, { name: 'Ain Smara', nameAr: 'عين السمارة' }, { name: 'Ben Badis', nameAr: 'أبن باديس الهرية' }, { name: 'Beni Hamidane', nameAr: 'بني حميدان' }, { name: 'Constantine', nameAr: 'قسنطينة' }, { name: 'Didouche Mourad', nameAr: 'ديدوش مراد' }, { name: 'El Khroub', nameAr: 'الخروب' }, { name: 'Hamma Bouziane', nameAr: 'حامة بوزيان' }, { name: 'Ibn Ziad', nameAr: 'ابن زياد' }, { name: 'Messaoud Boudjeriou', nameAr: 'بوجريو مسعود' }, { name: 'Ouled Rahmoun', nameAr: 'أولاد رحمون' }, { name: 'Zighoud Youcef', nameAr: 'زيغود يوسف' },
    ],
  },
  {
    code: '26',
    name: 'Médéa',
    nameAr: 'المدية',
    communes: [ { name: 'Ain Boucif', nameAr: 'عين بوسيف' }, { name: 'Ain Ouksir', nameAr: 'عين اقصير' }, { name: 'Aissaouia', nameAr: 'العيساوية' }, { name: 'Aziz', nameAr: 'عزيز' }, { name: 'Baata', nameAr: 'بعطة' }, { name: 'Ben Chicao', nameAr: 'بن شكاو' }, { name: 'Beni Slimane', nameAr: 'بني سليمان' }, { name: 'Berrouaghia', nameAr: 'البرواقية' }, { name: 'Bir Ben Laabed', nameAr: 'بئر بن عابد' }, { name: 'Boghar', nameAr: 'بوغار' }, { name: 'Bouaiche', nameAr: 'بوعيش' }, { name: 'Bouaichoune', nameAr: 'بوعيشون' }, { name: 'Bouchrahil', nameAr: 'بوشراحيل' }, { name: 'Boughzoul', nameAr: 'بوغزول' }, { name: 'Bouskene', nameAr: 'بوسكن' }, { name: 'Chabounia', nameAr: 'الشهبونية' }, { name: 'Chelalet El Adhaoura', nameAr: 'شلالة العذاورة' }, { name: 'Cheniguel', nameAr: 'شنيقل' }, { name: 'Derrag', nameAr: 'دراق' }, { name: 'Djouab', nameAr: 'جواب' }, { name: 'Draa Esmar', nameAr: 'ذراع السمار' }, { name: 'El Azizia', nameAr: 'العزيزية' }, { name: 'El Guelbelkebir', nameAr: 'القلب الكبير' }, { name: 'El Hamdania', nameAr: 'الحمدانية' }, { name: 'El Haoudane', nameAr: 'الحوضان' }, { name: 'El Omaria', nameAr: 'العمارية' }, { name: 'El Ouinet', nameAr: 'العوينات' }, { name: 'Hannacha', nameAr: 'حناشة' }, { name: 'Kef Lakhdar', nameAr: 'الكاف الاخضر' }, { name: 'Khams Djouamaa', nameAr: 'خمس جوامع' }, { name: 'Ksar El Boukhari', nameAr: 'قصر البخاري' }, { name: 'M\'fatha', nameAr: 'مفاتحة' }, { name: 'Maghraoua', nameAr: 'مغراوة' }, { name: 'Medea', nameAr: 'المدية' }, { name: 'Medjebar', nameAr: 'مجبر' }, { name: 'Mezerana', nameAr: 'مزغنة' }, { name: 'Mihoub', nameAr: 'ميهوب' }, { name: 'Ouamri', nameAr: 'عوامري' }, { name: 'Oued Harbil', nameAr: 'وادي حربيل' }, { name: 'Ouled Antar', nameAr: 'أولاد عنتر' }, { name: 'Ouled Bouachra', nameAr: 'أولاد بوعشرة' }, { name: 'Ouled Brahim', nameAr: 'أولاد إبراهيم' }, { name: 'Ouled Deid', nameAr: 'أولاد دايد' }, { name: 'Ouled Emaaraf', nameAr: 'أولاد امعرف' }, { name: 'Ouled Hellal', nameAr: 'أولاد هلال' }, { name: 'Oum El Djellil', nameAr: 'أم الجليل' }, { name: 'Ouzera', nameAr: 'وزرة' }, { name: 'Rebaia', nameAr: 'الربعية' }, { name: 'Saneg', nameAr: 'السانق' }, { name: 'Sedraya', nameAr: 'سدراية' }, { name: 'Seghouane', nameAr: 'سغوان' }, { name: 'Si Mahdjoub', nameAr: 'سي المحجوب' }, { name: 'Sidi Demed', nameAr: 'سيدي دامد' }, { name: 'Sidi Naamane', nameAr: 'سيدي نعمان' }, { name: 'Sidi Rabie', nameAr: 'سيدي الربيع' }, { name: 'Sidi Zahar', nameAr: 'سيدي زهار' }, { name: 'Sidi Ziane', nameAr: 'سيدي زيان' }, { name: 'Souagui', nameAr: 'السواقي' }, { name: 'Tablat', nameAr: 'تابلاط' }, { name: 'Tafraout', nameAr: 'تفراوت' }, { name: 'Tamesguida', nameAr: 'تمسقيدة' }, { name: 'Tizi Mahdi', nameAr: 'تيزي مهدي' }, { name: 'Tletat Ed Douair', nameAr: 'ثلاث دوائر' }, { name: 'Zoubiria', nameAr: 'الزبيرية' },
    ],
  },
  {
    code: '27',
    name: 'Mostaganem',
    nameAr: 'مستغانم',
    communes: [ { name: 'Achaacha', nameAr: 'عشعاشة' }, { name: 'Ain-Boudinar', nameAr: 'عين بودينار' }, { name: 'Ain-Nouissy', nameAr: 'عين نويسي' }, { name: 'Ain-Sidi Cherif', nameAr: 'عين سيدي الشريف' }, { name: 'Ain-Tedles', nameAr: 'عين تادلس' }, { name: 'Benabdelmalek Ramdane', nameAr: 'بن عبد المالك رمضان' }, { name: 'Bouguirat', nameAr: 'بوقيراط' }, { name: 'Fornaka', nameAr: 'فرناقة' }, { name: 'Hadjadj', nameAr: 'حجاج' }, { name: 'Hassi Mameche', nameAr: 'حاسي ماماش' }, { name: 'Hassiane', nameAr: 'الحسيان (بني ياحي' }, { name: 'Khadra', nameAr: 'خضرة' }, { name: 'Kheir-Eddine', nameAr: 'خير الدين' }, { name: 'Mansourah', nameAr: 'منصورة' }, { name: 'Mazagran', nameAr: 'مزغران' }, { name: 'Mesra', nameAr: 'ماسرة' }, { name: 'Mostaganem', nameAr: 'مستغانم' }, { name: 'Nekmaria', nameAr: 'نكمارية' }, { name: 'Oued El Kheir', nameAr: 'وادي الخير' }, { name: 'Ouled Boughalem', nameAr: 'أولاد بوغالم' }, { name: 'Ouled-Maalah', nameAr: 'أولاد مع الله' }, { name: 'Safsaf', nameAr: 'صفصاف' }, { name: 'Sayada', nameAr: 'صيادة' }, { name: 'Sidi Ali', nameAr: 'سيدي علي' }, { name: 'Sidi Belaattar', nameAr: 'سيدي بلعطار' }, { name: 'Sidi-Lakhdar', nameAr: 'سيدي لخضر' }, { name: 'Sirat', nameAr: 'سيرات' }, { name: 'Souaflia', nameAr: 'السوافلية' }, { name: 'Sour', nameAr: 'سور' }, { name: 'Stidia', nameAr: 'ستيدية' }, { name: 'Tazgait', nameAr: 'تزقايت' }, { name: 'Touahria', nameAr: 'الطواهرية' },
    ],
  },
  {
    code: '28',
    name: 'M\'Sila',
    nameAr: 'المسيلة',
    communes: [ { name: 'Ain El Hadjel', nameAr: 'عين الحجل' }, { name: 'Ain El Melh', nameAr: 'عين الملح' }, { name: 'Ain Fares', nameAr: 'عين فارس' }, { name: 'Ain Khadra', nameAr: 'عين الخضراء' }, { name: 'Ain Rich', nameAr: 'عين الريش' }, { name: 'Belaiba', nameAr: 'بلعايبة' }, { name: 'Ben Srour', nameAr: 'بن سرور' }, { name: 'Beni Ilmane', nameAr: 'بني يلمان' }, { name: 'Benzouh', nameAr: 'بن زوه' }, { name: 'Berhoum', nameAr: 'برهوم' }, { name: 'Bir Foda', nameAr: 'بئر فضة' }, { name: 'Bou Saada', nameAr: 'بوسعادة' }, { name: 'Bouti Sayeh', nameAr: 'بوطي السايح' }, { name: 'Chellal', nameAr: 'شلال' }, { name: 'Dehahna', nameAr: 'دهاهنة' }, { name: 'Djebel Messaad', nameAr: 'جبل مساعد' }, { name: 'El Hamel', nameAr: 'الهامل' }, { name: 'El Houamed', nameAr: 'الحوامد' }, { name: 'Hammam Dalaa', nameAr: 'حمام الضلعة' }, { name: 'Khettouti Sed-El-Jir', nameAr: 'خطوطي سد الجير' }, { name: 'Khoubana', nameAr: 'خبانة' }, { name: 'M\'cif', nameAr: 'مسيف' }, { name: 'M\'sila', nameAr: 'المسيلة' }, { name: 'M\'tarfa', nameAr: 'المطارفة' }, { name: 'Maadid', nameAr: 'المعاضيد' }, { name: 'Maarif', nameAr: 'معاريف' }, { name: 'Magra', nameAr: 'مقرة' }, { name: 'Medjedel', nameAr: 'امجدل' }, { name: 'Menaa', nameAr: 'مناعة' }, { name: 'Mohamed Boudiaf', nameAr: 'محمد بوضياف' }, { name: 'Ouanougha', nameAr: 'ونوغة' }, { name: 'Ouled Addi Guebala', nameAr: 'أولاد عدي لقبالة' }, { name: 'Ouled Derradj', nameAr: 'أولاد دراج' }, { name: 'Ouled Madhi', nameAr: 'أولاد ماضي' }, { name: 'Ouled Mansour', nameAr: 'أولاد منصور' }, { name: 'Ouled Sidi Brahim', nameAr: 'أولاد سيدي ابراهيم' }, { name: 'Ouled Slimane', nameAr: 'أولاد سليمان' }, { name: 'Oulteme', nameAr: 'ولتام' }, { name: 'Sidi Aissa', nameAr: 'سيدي عيسى' }, { name: 'Sidi Ameur', nameAr: 'سيدي عامر' }, { name: 'Sidi Hadjeres', nameAr: 'سيدي هجرس' }, { name: 'Sidi M\'hamed', nameAr: 'سيدي امحمد' }, { name: 'Slim', nameAr: 'سليم' }, { name: 'Souamaa', nameAr: 'السوامع' }, { name: 'Tamsa', nameAr: 'تامسة' }, { name: 'Tarmount', nameAr: 'تارمونت' }, { name: 'Zarzour', nameAr: 'زرزور' },
    ],
  },
  {
    code: '29',
    name: 'Mascara',
    nameAr: 'معسكر',
    communes: [ { name: 'Ain Fares', nameAr: 'عين فارس' }, { name: 'Ain Fekan', nameAr: 'عين فكان' }, { name: 'Ain Ferah', nameAr: 'عين فراح' }, { name: 'Ain Frass', nameAr: 'عين أفرص' }, { name: 'Alaimia', nameAr: 'العلايمية' }, { name: 'Aouf', nameAr: 'عوف' }, { name: 'Benian', nameAr: 'بنيان' }, { name: 'Bou Henni', nameAr: 'بوهني' }, { name: 'Bouhanifia', nameAr: 'بوحنيفية' }, { name: 'Chorfa', nameAr: 'الشرفاء' }, { name: 'El Bordj', nameAr: 'البرج' }, { name: 'El Gaada', nameAr: 'القعدة' }, { name: 'El Ghomri', nameAr: 'الغمري' }, { name: 'El Gueitena', nameAr: 'القطنة' }, { name: 'El Hachem', nameAr: 'الحشم' }, { name: 'El Keurt', nameAr: 'القرط' }, { name: 'El Mamounia', nameAr: 'المأمونية' }, { name: 'El Menaouer', nameAr: 'المنور' }, { name: 'Ferraguig', nameAr: 'فراقيق' }, { name: 'Froha', nameAr: 'فروحة' }, { name: 'Gharrous', nameAr: 'غروس' }, { name: 'Ghriss', nameAr: 'غريس' }, { name: 'Guerdjoum', nameAr: 'قرجوم' }, { name: 'Hacine', nameAr: 'حسين' }, { name: 'Khalouia', nameAr: 'خلوية' }, { name: 'Makhda', nameAr: 'ماقضة' }, { name: 'Maoussa', nameAr: 'ماوسة' }, { name: 'Mascara', nameAr: 'معسكر' }, { name: 'Matemore', nameAr: 'المطمور' }, { name: 'Mocta-Douz', nameAr: 'مقطع الدوز' }, { name: 'Mohammadia', nameAr: 'المحمدية' }, { name: 'Nesmot', nameAr: 'نسمط' }, { name: 'Oggaz', nameAr: 'عقاز' }, { name: 'Oued El Abtal', nameAr: 'وادي الأبطال' }, { name: 'Oued Taria', nameAr: 'وادي التاغية' }, { name: 'Ras El Ain Amirouche', nameAr: 'رأس عين عميروش' }, { name: 'Sedjerara', nameAr: 'سجرارة' }, { name: 'Sehailia', nameAr: 'السهايلية' }, { name: 'Sidi Abdeldjebar', nameAr: 'سيدي عبد الجبار' }, { name: 'Sidi Abdelmoumene', nameAr: 'سيدي عبد المومن' }, { name: 'Sidi Boussaid', nameAr: 'سيدي بوسعيد' }, { name: 'Sidi Kada', nameAr: 'سيدي قادة' }, { name: 'Sig', nameAr: 'سيق' }, { name: 'Tighennif', nameAr: 'تيغنيف' }, { name: 'Tizi', nameAr: 'تيزي' }, { name: 'Zahana', nameAr: 'زهانة' }, { name: 'Zelamta', nameAr: 'زلامطة' },
    ],
  },
  {
    code: '30',
    name: 'Ouargla',
    nameAr: 'ورقلة',
    communes: [ { name: 'Ain Beida', nameAr: 'عين البيضاء' }, { name: 'El Borma', nameAr: 'البرمة' }, { name: 'Hassi Ben Abdellah', nameAr: 'حاسي بن عبد الله' }, { name: 'Hassi Messaoud', nameAr: 'حاسي مسعود' }, { name: 'N\'goussa', nameAr: 'انقوسة' }, { name: 'Ouargla', nameAr: 'ورقلة' }, { name: 'Rouissat', nameAr: 'الرويسات' }, { name: 'Sidi Khouiled', nameAr: 'سيدي خويلد' },
    ],
  },
  {
    code: '31',
    name: 'Oran',
    nameAr: 'وهران',
    communes: [ { name: 'Ain Biya', nameAr: 'عين البية' }, { name: 'Ain Kerma', nameAr: 'عين الكرمة' }, { name: 'Ain Turk', nameAr: 'عين الترك' }, { name: 'Arzew', nameAr: 'أرزيو' }, { name: 'Ben Freha', nameAr: 'بن فريحة' }, { name: 'Bethioua', nameAr: 'بطيوة' }, { name: 'Bir El Djir', nameAr: 'بئر الجير' }, { name: 'Boufatis', nameAr: 'بوفاتيس' }, { name: 'Bousfer', nameAr: 'بوسفر' }, { name: 'Boutlelis', nameAr: 'بوتليليس' }, { name: 'El Ancor', nameAr: 'العنصر' }, { name: 'El Braya', nameAr: 'البراية' }, { name: 'El Kerma', nameAr: 'الكرمة' }, { name: 'Es Senia', nameAr: 'السانية' }, { name: 'Gdyel', nameAr: 'قديل' }, { name: 'Hassi Ben Okba', nameAr: 'حاسي بن عقبة' }, { name: 'Hassi Bounif', nameAr: 'حاسي بونيف' }, { name: 'Hassi Mefsoukh', nameAr: 'حاسي مفسوخ' }, { name: 'Marsat El Hadjadj', nameAr: 'مرسى الحجاج' }, { name: 'Mers El Kebir', nameAr: 'المرسى الكبير' }, { name: 'Messerghin', nameAr: 'مسرغين' }, { name: 'Oran', nameAr: 'وهران' }, { name: 'Oued Tlelat', nameAr: 'وادي تليلات' }, { name: 'Sidi Ben Yebka', nameAr: 'سيدي بن يبقى' }, { name: 'Sidi Chami', nameAr: 'سيدي الشحمي' }, { name: 'Tafraoui', nameAr: 'طفراوي' },
    ],
  },
  {
    code: '32',
    name: 'El Bayadh',
    nameAr: 'البيض',
    communes: [ { name: 'Ain El Orak', nameAr: 'عين العراك' }, { name: 'Arbaouat', nameAr: 'اربوات' }, { name: 'Boualem', nameAr: 'بوعلام' }, { name: 'Bougtoub', nameAr: 'بوقطب' }, { name: 'Boussemghoun', nameAr: 'بوسمغون' }, { name: 'Brezina', nameAr: 'بريزينة' }, { name: 'Cheguig', nameAr: 'الشقيق' }, { name: 'Chellala', nameAr: 'شلالة' }, { name: 'El Bayadh', nameAr: 'البيض' }, { name: 'El Bnoud', nameAr: 'البنود' }, { name: 'El Kheiter', nameAr: 'الخيثر' }, { name: 'El Mehara', nameAr: 'المحرة' }, { name: 'Ghassoul', nameAr: 'الغاسول' }, { name: 'Kef El Ahmar', nameAr: 'الكاف الأحمر' }, { name: 'Krakda', nameAr: 'كراكدة' }, { name: 'Labiodh Sidi Cheikh', nameAr: 'الأبيض سيدي الشيخ' }, { name: 'Rogassa', nameAr: 'رقاصة' }, { name: 'Sidi Ameur', nameAr: 'سيدي عامر' }, { name: 'Sidi Slimane', nameAr: 'سيدي سليمان' }, { name: 'Sidi Tiffour', nameAr: 'سيدي طيفور' }, { name: 'Stitten', nameAr: 'ستيتن' }, { name: 'Tousmouline', nameAr: 'توسمولين' },
    ],
  },
  {
    code: '33',
    name: 'Illizi',
    nameAr: 'إليزي',
    communes: [ { name: 'Bordj Omar Driss', nameAr: 'برج عمر إدريس' }, { name: 'Debdeb', nameAr: 'دبداب' }, { name: 'Illizi', nameAr: 'إيليزي' }, { name: 'In Amenas', nameAr: 'إن أمناس' },
    ],
  },
  {
    code: '34',
    name: 'Bordj Bou Arreridj',
    nameAr: 'برج بوعريريج',
    communes: [ { name: 'Ain Taghrout', nameAr: 'عين تاغروت' }, { name: 'Ain Tesra', nameAr: 'عين تسرة' }, { name: 'B. B. Arreridj', nameAr: 'برج بوعريرج' }, { name: 'Belimour', nameAr: 'بليمور' }, { name: 'Ben Daoud', nameAr: 'بن داود' }, { name: 'Bir Kasdali', nameAr: 'بئر قاصد علي' }, { name: 'Bordj Ghedir', nameAr: 'برج الغدير' }, { name: 'Bordj Zemmoura', nameAr: 'برج زمورة' }, { name: 'Colla', nameAr: 'القلة' }, { name: 'Djaafra', nameAr: 'جعافرة' }, { name: 'El Achir', nameAr: 'الياشير' }, { name: 'El Annasseur', nameAr: 'العناصر' }, { name: 'El Euch', nameAr: 'العش' }, { name: 'El M\'hir', nameAr: 'المهير' }, { name: 'El Main', nameAr: 'الماين' }, { name: 'Elhammadia', nameAr: 'الحمادية' }, { name: 'Ghailasa', nameAr: 'غيلاسة' }, { name: 'Haraza', nameAr: 'حرازة' }, { name: 'Hasnaoua', nameAr: 'حسناوة' }, { name: 'Khelil', nameAr: 'خليل' }, { name: 'Ksour', nameAr: 'القصور' }, { name: 'Mansoura', nameAr: 'المنصورة' }, { name: 'Medjana', nameAr: 'مجانة' }, { name: 'Ouled Brahem', nameAr: 'أولاد أبراهم' }, { name: 'Ouled Dahmane', nameAr: 'أولاد دحمان' }, { name: 'Ouled Sidi-Brahim', nameAr: 'أولاد سيدي ابراهيم' }, { name: 'Rabta', nameAr: 'الرابطة' }, { name: 'Ras El Oued', nameAr: 'رأس الوادي' }, { name: 'Sidi-Embarek', nameAr: 'سيدي أمبارك' }, { name: 'Taglait', nameAr: 'تقلعيت' }, { name: 'Tassamert', nameAr: 'تسامرت' }, { name: 'Tefreg', nameAr: 'تفرق' }, { name: 'Teniet En Nasr', nameAr: 'ثنية النصر' }, { name: 'Tixter', nameAr: 'تيكستار' },
    ],
  },
  {
    code: '35',
    name: 'Boumerdès',
    nameAr: 'بومرداس',
    communes: [ { name: 'Afir', nameAr: 'أعفير' }, { name: 'Ammal', nameAr: 'عمال' }, { name: 'Baghlia', nameAr: 'بغلية' }, { name: 'Ben Choud', nameAr: 'بن شود' }, { name: 'Beni Amrane', nameAr: 'بني عمران' }, { name: 'Bordj Menaiel', nameAr: 'برج منايل' }, { name: 'Boudouaou', nameAr: 'بودواو' }, { name: 'Boudouaou El Bahri', nameAr: 'بودواو البحري' }, { name: 'Boumerdes', nameAr: 'بومرداس' }, { name: 'Bouzegza Keddara', nameAr: 'بوزقزة قدارة' }, { name: 'Chabet El Ameur', nameAr: 'شعبة العامر' }, { name: 'Corso', nameAr: 'قورصو' }, { name: 'Dellys', nameAr: 'دلس' }, { name: 'Djinet', nameAr: 'جنات' }, { name: 'El Kharrouba', nameAr: 'الخروبة' }, { name: 'Hammedi', nameAr: 'حمادي' }, { name: 'Isser', nameAr: 'يسر' }, { name: 'Khemis El Khechna', nameAr: 'خميس الخشنة' }, { name: 'Larbatache', nameAr: 'الاربعطاش' }, { name: 'Leghata', nameAr: 'لقاطة' }, { name: 'Naciria', nameAr: 'الناصرية' }, { name: 'Ouled Aissa', nameAr: 'أولاد عيسى' }, { name: 'Ouled Hedadj', nameAr: 'أولاد هداج' }, { name: 'Ouled Moussa', nameAr: 'أولاد موسى' }, { name: 'Si Mustapha', nameAr: 'سي مصطفى' }, { name: 'Sidi Daoud', nameAr: 'سيدي داود' }, { name: 'Souk El Had', nameAr: 'سوق الحد' }, { name: 'Taourga', nameAr: 'تاورقة' }, { name: 'Thenia', nameAr: 'الثنية' }, { name: 'Tidjelabine', nameAr: 'تيجلابين' }, { name: 'Timezrit', nameAr: 'تيمزريت' }, { name: 'Zemmouri', nameAr: 'زموري' },
    ],
  },
  {
    code: '36',
    name: 'El Tarf',
    nameAr: 'الطارف',
    communes: [ { name: 'Ain El Assel', nameAr: 'عين العسل' }, { name: 'Ain Kerma', nameAr: 'عين الكرمة' }, { name: 'Asfour', nameAr: 'عصفور' }, { name: 'Ben M Hidi', nameAr: 'بن مهيدي' }, { name: 'Berrihane', nameAr: 'بريحان' }, { name: 'Besbes', nameAr: 'البسباس' }, { name: 'Bougous', nameAr: 'بوقوس' }, { name: 'Bouhadjar', nameAr: 'بوحجار' }, { name: 'Bouteldja', nameAr: 'بوثلجة' }, { name: 'Chebaita Mokhtar', nameAr: 'شبيطة مختار' }, { name: 'Chefia', nameAr: 'الشافية' }, { name: 'Chihani', nameAr: 'شحاني' }, { name: 'Drean', nameAr: 'الذرعـان' }, { name: 'Echatt', nameAr: 'الشط' }, { name: 'El Aioun', nameAr: 'العيون' }, { name: 'El Kala', nameAr: 'القالة' }, { name: 'El Tarf', nameAr: 'الطارف' }, { name: 'Hammam Beni Salah', nameAr: 'حمام بني صالح' }, { name: 'Lac Des Oiseaux', nameAr: 'بحيرة الطيور' }, { name: 'Oued Zitoun', nameAr: 'وادي الزيتون' }, { name: 'Raml Souk', nameAr: 'رمل السوق' }, { name: 'Souarekh', nameAr: 'السوارخ' }, { name: 'Zerizer', nameAr: 'زريزر' }, { name: 'Zitouna', nameAr: 'الزيتونة' },
    ],
  },
  {
    code: '37',
    name: 'Tindouf',
    nameAr: 'تندوف',
    communes: [ { name: 'Oum El Assel', nameAr: 'أم العسل' }, { name: 'Tindouf', nameAr: 'تندوف' },
    ],
  },
  {
    code: '38',
    name: 'Tissemsilt',
    nameAr: 'تيسمسيلت',
    communes: [ { name: 'Ammari', nameAr: 'عماري' }, { name: 'Beni Chaib', nameAr: 'بني شعيب' }, { name: 'Beni Lahcene', nameAr: 'بني لحسن' }, { name: 'Bordj Bounaama', nameAr: 'برج بونعامة' }, { name: 'Bordj El Emir Abdelkader', nameAr: 'برج الأمير عبد القادر' }, { name: 'Boucaid', nameAr: 'بوقائد' }, { name: 'Khemisti', nameAr: 'خميستي' }, { name: 'Larbaa', nameAr: 'الأربعاء' }, { name: 'Lardjem', nameAr: 'لرجام' }, { name: 'Layoune', nameAr: 'العيون' }, { name: 'Lazharia', nameAr: 'الأزهرية' }, { name: 'Maacem', nameAr: 'المعاصم' }, { name: 'Melaab', nameAr: 'الملعب' }, { name: 'Ouled Bessam', nameAr: 'أولاد بسام' }, { name: 'Sidi Abed', nameAr: 'سيدي عابد' }, { name: 'Sidi Boutouchent', nameAr: 'سيدي بوتوشنت' }, { name: 'Sidi Lantri', nameAr: 'سيدي العنتري' }, { name: 'Sidi Slimane', nameAr: 'سيدي سليمان' }, { name: 'Tamellahet', nameAr: 'تملاحت' }, { name: 'Theniet El Had', nameAr: 'ثنية الاحد' }, { name: 'Tissemsilt', nameAr: 'تيسمسيلت' }, { name: 'Youssoufia', nameAr: 'اليوسفية' },
    ],
  },
  {
    code: '39',
    name: 'El Oued',
    nameAr: 'الوادي',
    communes: [ { name: 'Bayadha', nameAr: 'البياضة' }, { name: 'Ben Guecha', nameAr: 'بن  قشة' }, { name: 'Debila', nameAr: 'الدبيلة' }, { name: 'Douar El Maa', nameAr: 'دوار الماء' }, { name: 'El Ogla', nameAr: 'العقلة' }, { name: 'El-Oued', nameAr: 'الوادي' }, { name: 'Guemar', nameAr: 'قمار' }, { name: 'Hamraia', nameAr: 'الحمراية' }, { name: 'Hassani Abdelkrim', nameAr: 'حساني عبد الكريم' }, { name: 'Hassi Khalifa', nameAr: 'حاسي خليفة' }, { name: 'Kouinine', nameAr: 'كوينين' }, { name: 'Magrane', nameAr: 'المقرن' }, { name: 'Mih Ouansa', nameAr: 'اميه وانسة' }, { name: 'Nakhla', nameAr: 'النخلة' }, { name: 'Oued El Alenda', nameAr: 'وادي العلندة' }, { name: 'Ourmes', nameAr: 'ورماس' }, { name: 'Reguiba', nameAr: 'الرقيبة' }, { name: 'Robbah', nameAr: 'الرباح' }, { name: 'Sidi Aoun', nameAr: 'سيدي عون' }, { name: 'Taghzout', nameAr: 'تغزوت' }, { name: 'Taleb Larbi', nameAr: 'الطالب العربي' }, { name: 'Trifaoui', nameAr: 'الطريفاوي' },
    ],
  },
  {
    code: '40',
    name: 'Khenchela',
    nameAr: 'خنشلة',
    communes: [ { name: 'Ain Touila', nameAr: 'عين الطويلة' }, { name: 'Babar', nameAr: 'بابار' }, { name: 'Baghai', nameAr: 'بغاي' }, { name: 'Bouhmama', nameAr: 'بوحمامة' }, { name: 'Chechar', nameAr: 'ششار' }, { name: 'Chelia', nameAr: 'شلية' }, { name: 'Djellal', nameAr: 'جلال' }, { name: 'El Hamma', nameAr: 'الحامة' }, { name: 'El Mahmal', nameAr: 'المحمل' }, { name: 'El Oueldja', nameAr: 'الولجة' }, { name: 'Ensigha', nameAr: 'انسيغة' }, { name: 'Kais', nameAr: 'قايس' }, { name: 'Khenchela', nameAr: 'خنشلة' }, { name: 'Khirane', nameAr: 'خيران' }, { name: 'M\'sara', nameAr: 'مصارة' }, { name: 'M\'toussa', nameAr: 'متوسة' }, { name: 'Ouled Rechache', nameAr: 'أولاد رشاش' }, { name: 'Remila', nameAr: 'الرميلة' }, { name: 'Tamza', nameAr: 'طامزة' }, { name: 'Taouzianat', nameAr: 'تاوزيانت' }, { name: 'Yabous', nameAr: 'يابوس' },
    ],
  },
  {
    code: '41',
    name: 'Souk Ahras',
    nameAr: 'سوق أهراس',
    communes: [ { name: 'Ain Soltane', nameAr: 'عين سلطان' }, { name: 'Ain Zana', nameAr: 'عين الزانة' }, { name: 'Bir Bouhouche', nameAr: 'بئر بوحوش' }, { name: 'Drea', nameAr: 'الدريعة' }, { name: 'Haddada', nameAr: 'الحدادة' }, { name: 'Hanencha', nameAr: 'الحنانشة' }, { name: 'Khedara', nameAr: 'الخضارة' }, { name: 'Khemissa', nameAr: 'خميسة' }, { name: 'M\'daourouche', nameAr: 'مداوروش' }, { name: 'Machroha', nameAr: 'المشروحة' }, { name: 'Merahna', nameAr: 'المراهنة' }, { name: 'Oued Kebrit', nameAr: 'وادي الكبريت' }, { name: 'Ouillen', nameAr: 'ويلان' }, { name: 'Ouled Driss', nameAr: 'أولاد إدريس' }, { name: 'Ouled Moumen', nameAr: 'أولاد مومن' }, { name: 'Oum El Adhaim', nameAr: 'أم العظايم' }, { name: 'Ragouba', nameAr: 'الراقوبة' }, { name: 'Safel El Ouiden', nameAr: 'سافل الويدان' }, { name: 'Sedrata', nameAr: 'سدراتة' }, { name: 'Sidi Fredj', nameAr: 'سيدي فرج' }, { name: 'Souk Ahras', nameAr: 'سوق أهراس' }, { name: 'Taoura', nameAr: 'تاورة' }, { name: 'Terraguelt', nameAr: 'ترقالت' }, { name: 'Tiffech', nameAr: 'تيفاش' }, { name: 'Zaarouria', nameAr: 'الزعرورية' }, { name: 'Zouabi', nameAr: 'الزوابي' },
    ],
  },
  {
    code: '42',
    name: 'Tipaza',
    nameAr: 'تيبازة',
    communes: [ { name: 'Aghbal', nameAr: 'أغبال' }, { name: 'Ahmer El Ain', nameAr: 'أحمر العين' }, { name: 'Ain Tagourait', nameAr: 'عين تاقورايت' }, { name: 'Attatba', nameAr: 'الحطاطبة' }, { name: 'Beni Mileuk', nameAr: 'بني ميلك' }, { name: 'Bou Haroun', nameAr: 'بوهارون' }, { name: 'Bou Ismail', nameAr: 'بواسماعيل' }, { name: 'Bourkika', nameAr: 'بورقيقة' }, { name: 'Chaiba', nameAr: 'الشعيبة' }, { name: 'Cherchell', nameAr: 'شرشال' }, { name: 'Damous', nameAr: 'الداموس' }, { name: 'Douaouda', nameAr: 'دواودة' }, { name: 'Fouka', nameAr: 'فوكة' }, { name: 'Gouraya', nameAr: 'قوراية' }, { name: 'Hadjout', nameAr: 'حجوط' }, { name: 'Hadjret Ennous', nameAr: 'حجرة النص' }, { name: 'Khemisti', nameAr: 'خميستي' }, { name: 'Kolea', nameAr: 'القليعة' }, { name: 'Larhat', nameAr: 'الأرهاط' }, { name: 'Menaceur', nameAr: 'مناصر' }, { name: 'Merad', nameAr: 'مراد' }, { name: 'Messelmoun', nameAr: 'مسلمون' }, { name: 'Nador', nameAr: 'الناظور' }, { name: 'Sidi Ghiles', nameAr: 'سيدي غيلاس' }, { name: 'Sidi Rached', nameAr: 'سيدي راشد' }, { name: 'Sidi Semiane', nameAr: 'سيدي سميان' }, { name: 'Sidi-Amar', nameAr: 'سيدي عامر' }, { name: 'Tipaza', nameAr: 'تيبازة' },
    ],
  },
  {
    code: '43',
    name: 'Mila',
    nameAr: 'ميلة',
    communes: [ { name: 'Ahmed Rachedi', nameAr: 'أحمد راشدي' }, { name: 'Ain Beida Harriche', nameAr: ' عين البيضاء أحريش' }, { name: 'Ain Mellouk', nameAr: 'عين الملوك' }, { name: 'Ain Tine', nameAr: 'عين التين' }, { name: 'Amira Arres', nameAr: 'اعميرة اراس' }, { name: 'Benyahia Abderrahmane', nameAr: 'بن يحي عبد الرحمن' }, { name: 'Bouhatem', nameAr: 'بوحاتم' }, { name: 'Chelghoum Laid', nameAr: 'شلغوم العيد' }, { name: 'Chigara', nameAr: 'الشيقارة' }, { name: 'Derrahi Bousselah', nameAr: 'دراحي بوصلاح' }, { name: 'El Ayadi Barbes', nameAr: 'العياضي برباس' }, { name: 'El Mechira', nameAr: 'مشيرة' }, { name: 'Ferdjioua', nameAr: 'فرجيوة' }, { name: 'Grarem Gouga', nameAr: 'القرارم قوقة' }, { name: 'Hamala', nameAr: 'حمالة' }, { name: 'Mila', nameAr: 'ميلة' }, { name: 'Minar Zarza', nameAr: 'مينار زارزة' }, { name: 'Oued Athmenia', nameAr: 'وادي العثمانية' }, { name: 'Oued Endja', nameAr: 'وادي النجاء' }, { name: 'Oued Seguen', nameAr: 'وادي سقان' }, { name: 'Ouled Khalouf', nameAr: 'أولاد اخلوف' }, { name: 'Rouached', nameAr: 'الرواشد' }, { name: 'Sidi Khelifa', nameAr: 'سيدي خليفة' }, { name: 'Sidi Merouane', nameAr: 'سيدي مروان' }, { name: 'Tadjenanet', nameAr: 'تاجنانت' }, { name: 'Tassadane Haddada', nameAr: 'تسدان حدادة' }, { name: 'Tassala Lematai', nameAr: 'تسالة لمطاعي' }, { name: 'Teleghma', nameAr: 'التلاغمة' }, { name: 'Terrai Bainen', nameAr: 'ترعي باينان' }, { name: 'Tiberguent', nameAr: 'تيبرقنت' }, { name: 'Yahia Beniguecha', nameAr: 'يحي بني قشة' }, { name: 'Zeghaia', nameAr: 'زغاية' },
    ],
  },
  {
    code: '44',
    name: 'Aïn Defla',
    nameAr: 'عين الدفلة',
    communes: [ { name: 'Ain-Benian', nameAr: 'عين البنيان' }, { name: 'Ain-Bouyahia', nameAr: 'عين بويحيى' }, { name: 'Ain-Defla', nameAr: 'عين الدفلى' }, { name: 'Ain-Lechiakh', nameAr: 'عين الاشياخ' }, { name: 'Ain-Soltane', nameAr: 'عين السلطان' }, { name: 'Ain-Torki', nameAr: 'عين التركي' }, { name: 'Arib', nameAr: 'عريب' }, { name: 'Bathia', nameAr: 'بطحية' }, { name: 'Belaas', nameAr: 'بلعاص' }, { name: 'Ben Allal', nameAr: 'بن علال' }, { name: 'Bir-Ould-Khelifa', nameAr: 'بئر ولد خليفة' }, { name: 'Birbouche', nameAr: 'بربوش' }, { name: 'Bordj-Emir-Khaled', nameAr: 'برج الأمير خالد' }, { name: 'Boumedfaa', nameAr: 'بومدفع' }, { name: 'Bourached', nameAr: 'بوراشد' }, { name: 'Djelida', nameAr: 'جليدة' }, { name: 'Djemaa Ouled Cheikh', nameAr: 'جمعة أولاد الشيخ' }, { name: 'Djendel', nameAr: 'جندل' }, { name: 'El-Abadia', nameAr: 'العبادية' }, { name: 'El-Amra', nameAr: 'العامرة' }, { name: 'El-Attaf', nameAr: 'العطاف' }, { name: 'El-Maine', nameAr: 'الماين' }, { name: 'Hammam-Righa', nameAr: 'حمام ريغة' }, { name: 'Hassania', nameAr: 'الحسانية' }, { name: 'Hoceinia', nameAr: 'الحسينية' }, { name: 'Khemis-Miliana', nameAr: 'خميس مليانة' }, { name: 'Mekhatria', nameAr: 'المخاطرية' }, { name: 'Miliana', nameAr: 'مليانة' }, { name: 'Oued Chorfa', nameAr: 'وادي الشرفاء' }, { name: 'Oued Djemaa', nameAr: 'واد الجمعة' }, { name: 'Rouina', nameAr: 'الروينة' }, { name: 'Sidi-Lakhdar', nameAr: 'سيدي الأخضر' }, { name: 'Tacheta Zegagha', nameAr: 'تاشتة زقاغة' }, { name: 'Tarik-Ibn-Ziad', nameAr: 'طارق بن زياد' }, { name: 'Tiberkanine', nameAr: 'تبركانين' }, { name: 'Zeddine', nameAr: 'زدين' },
    ],
  },
  {
    code: '45',
    name: 'Naâma',
    nameAr: 'النعامة',
    communes: [ { name: 'Ain Ben Khelil', nameAr: 'عين بن خليل' }, { name: 'Ain Sefra', nameAr: 'عين الصفراء' }, { name: 'Asla', nameAr: 'عسلة' }, { name: 'Djenienne Bourezg', nameAr: 'جنين بورزق' }, { name: 'El Biodh', nameAr: 'البيوض' }, { name: 'Kasdir', nameAr: 'القصدير' }, { name: 'Makmen Ben Amar', nameAr: 'مكمن بن عمار' }, { name: 'Mecheria', nameAr: 'المشرية' }, { name: 'Moghrar', nameAr: 'مغرار' }, { name: 'Naama', nameAr: 'النعامة' }, { name: 'Sfissifa', nameAr: 'سفيسيفة' }, { name: 'Tiout', nameAr: 'تيوت' },
    ],
  },
  {
    code: '46',
    name: 'Aïn Témouchent',
    nameAr: 'عين تيموشنت',
    communes: [ { name: 'Aghlal', nameAr: 'أغلال' }, { name: 'Ain El Arbaa', nameAr: 'عين الأربعاء' }, { name: 'Ain Kihal', nameAr: 'عين الكيحل' }, { name: 'Ain Temouchent', nameAr: 'عين تموشنت' }, { name: 'Ain Tolba', nameAr: 'عين الطلبة' }, { name: 'Aoubellil', nameAr: 'عقب الليل' }, { name: 'Beni Saf', nameAr: 'بني صاف' }, { name: 'Bouzedjar', nameAr: 'بوزجار' }, { name: 'Chaabat El Ham', nameAr: 'شعبة اللحم' }, { name: 'Chentouf', nameAr: 'شنتوف' }, { name: 'El Amria', nameAr: 'العامرية' }, { name: 'El Maleh', nameAr: 'المالح' }, { name: 'El Messaid', nameAr: 'المساعيد' }, { name: 'Emir Abdelkader', nameAr: 'الأمير عبد القادر' }, { name: 'Hammam Bou Hadjar', nameAr: 'حمام بوحجر' }, { name: 'Hassasna', nameAr: 'الحساسنة' }, { name: 'Hassi El Ghella', nameAr: 'حاسي الغلة' }, { name: 'Oued Berkeche', nameAr: 'وادي برقش' }, { name: 'Oued Sebbah', nameAr: 'وادي الصباح' }, { name: 'Ouled Boudjemaa', nameAr: 'أولاد بوجمعة' }, { name: 'Ouled Kihal', nameAr: 'أولاد الكيحل' }, { name: 'Oulhaca El Gheraba', nameAr: 'ولهاصة الغرابة' }, { name: 'Sidi Ben Adda', nameAr: 'سيدي بن عدة' }, { name: 'Sidi Boumediene', nameAr: 'سيدي بومدين' }, { name: 'Sidi Ouriache', nameAr: 'سيدي ورياش' }, { name: 'Sidi Safi', nameAr: 'سيدي صافي' }, { name: 'Tamzoura', nameAr: 'تامزورة' }, { name: 'Terga', nameAr: 'تارقة' },
    ],
  },
  {
    code: '47',
    name: 'Ghardaïa',
    nameAr: 'غرداية',
    communes: [ { name: 'Berriane', nameAr: 'بريان' }, { name: 'Bounoura', nameAr: 'بونورة' }, { name: 'Dhayet Bendhahoua', nameAr: 'ضاية بن ضحوة' }, { name: 'El Atteuf', nameAr: 'العطف' }, { name: 'El Guerrara', nameAr: 'القرارة' }, { name: 'Ghardaia', nameAr: 'غرداية' }, { name: 'Mansoura', nameAr: 'المنصورة' }, { name: 'Metlili', nameAr: 'متليلي' }, { name: 'Sebseb', nameAr: 'سبسب' }, { name: 'Zelfana', nameAr: 'زلفانة' },
    ],
  },
  {
    code: '48',
    name: 'Relizane',
    nameAr: 'غليزان',
    communes: [ { name: 'Ain Rahma', nameAr: 'عين الرحمة' }, { name: 'Ain-Tarek', nameAr: 'عين طارق' }, { name: 'Ammi Moussa', nameAr: 'عمي موسى' }, { name: 'Belaassel Bouzagza', nameAr: 'بلعسل بوزقزة' }, { name: 'Bendaoud', nameAr: 'بن داود' }, { name: 'Beni Dergoun', nameAr: 'بني درقن' }, { name: 'Beni Zentis', nameAr: 'بني زنطيس' }, { name: 'Dar Ben Abdelah', nameAr: 'دار بن عبد الله' }, { name: 'Djidiouia', nameAr: 'جديوية' }, { name: 'El H\'madna', nameAr: 'الحمادنة' }, { name: 'El Hassi', nameAr: 'الحاسي' }, { name: 'El Ouldja', nameAr: 'الولجة' }, { name: 'El-Guettar', nameAr: 'القطار' }, { name: 'El-Matmar', nameAr: 'المطمر' }, { name: 'Had Echkalla', nameAr: 'حد الشكالة' }, { name: 'Hamri', nameAr: 'حمري' }, { name: 'Kalaa', nameAr: 'القلعة' }, { name: 'Lahlef', nameAr: 'لحلاف' }, { name: 'Mazouna', nameAr: 'مازونة' }, { name: 'Mediouna', nameAr: 'مديونة' }, { name: 'Mendes', nameAr: 'منداس' }, { name: 'Merdja Sidi Abed', nameAr: 'مرجة سيدي عابد' }, { name: 'Ouarizane', nameAr: 'واريزان' }, { name: 'Oued El Djemaa', nameAr: 'وادي الجمعة' }, { name: 'Oued Essalem', nameAr: 'وادي السلام' }, { name: 'Oued-Rhiou', nameAr: 'وادي رهيو' }, { name: 'Ouled Aiche', nameAr: 'أولاد يعيش' }, { name: 'Ouled Sidi Mihoub', nameAr: 'أولاد سيدي الميهوب' }, { name: 'Ramka', nameAr: 'الرمكة' }, { name: 'Relizane', nameAr: 'غليزان' }, { name: 'Sidi Khettab', nameAr: 'سيدي  خطاب' }, { name: 'Sidi Lazreg', nameAr: 'سيدي لزرق' }, { name: 'Sidi M\'hamed Benali', nameAr: 'سيدي أمحمد بن علي' }, { name: 'Sidi M\'hamed Benaouda', nameAr: 'سيدي امحمد بن عودة' }, { name: 'Sidi Saada', nameAr: 'سيدي سعادة' }, { name: 'Souk El Had', nameAr: 'سوق الحد' }, { name: 'Yellel', nameAr: 'يلل' }, { name: 'Zemmoura', nameAr: 'زمورة' },
    ],
  },
  {
    code: '49',
    name: 'Timimoun',
    nameAr: 'تيميمون',
    communes: [ { name: 'Aougrout', nameAr: 'أوقروت' }, { name: 'Charouine', nameAr: 'شروين' }, { name: 'Deldoul', nameAr: 'دلدول' }, { name: 'Ksar Kaddour', nameAr: 'قصر قدور' }, { name: 'Metarfa', nameAr: 'المطارفة' }, { name: 'Ouled Aissa', nameAr: 'أولاد عيسى' }, { name: 'Ouled Said', nameAr: 'أولاد السعيد' }, { name: 'Talmine', nameAr: 'طالمين' }, { name: 'Timimoun', nameAr: 'تيميمون' }, { name: 'Tinerkouk', nameAr: 'تنركوك' },
    ],
  },
  {
    code: '50',
    name: 'Bordj Badji Mokhtar',
    nameAr: 'برج باجي مختار',
    communes: [ { name: 'Bordj Badji Mokhtar', nameAr: 'برج باجي مختار' }, { name: 'Timiaouine', nameAr: 'تيمياوين' },
    ],
  },
  {
    code: '51',
    name: 'Ouled Djellal',
    nameAr: 'أولاد جلال',
    communes: [ { name: 'Besbes', nameAr: 'بسباس' }, { name: 'Chaiba', nameAr: 'الشعيبة' }, { name: 'Doucen', nameAr: 'الدوسن' }, { name: 'Ouled Djellal', nameAr: 'أولاد جلال' }, { name: 'Ras El Miad', nameAr: 'رأس الميعاد' }, { name: 'Sidi Khaled', nameAr: 'سيدي  خالد' },
    ],
  },
  {
    code: '52',
    name: 'Béni Abbès',
    nameAr: 'بني عباس',
    communes: [ { name: 'Beni-Abbes', nameAr: 'بني عباس' }, { name: 'Beni-Ikhlef', nameAr: 'بن يخلف' }, { name: 'El Ouata', nameAr: 'الواتة' }, { name: 'Igli', nameAr: 'إقلي' }, { name: 'Kerzaz', nameAr: 'كرزاز' }, { name: 'Ksabi', nameAr: 'القصابي' }, { name: 'Ouled-Khodeir', nameAr: 'أولاد خضير' }, { name: 'Tamtert', nameAr: 'تامترت' }, { name: 'Timoudi', nameAr: 'تيمودي' },
    ],
  },
  {
    code: '53',
    name: 'In Salah',
    nameAr: 'عين صالح',
    communes: [ { name: 'Ain Salah', nameAr: 'عين صالح' }, { name: 'Foggaret Ezzoua', nameAr: 'فقارة الزوى' }, { name: 'Inghar', nameAr: 'إينغر' },
    ],
  },
  {
    code: '54',
    name: 'In Guezzam',
    nameAr: 'عين قزام',
    communes: [ { name: 'Ain Guezzam', nameAr: 'عين قزام' }, { name: 'Tin Zouatine', nameAr: 'تين زواتين' },
    ],
  },
  {
    code: '55',
    name: 'Touggourt',
    nameAr: 'تقرت',
    communes: [ { name: 'Benaceur', nameAr: 'بن ناصر' }, { name: 'Blidet Amor', nameAr: 'بلدة اعمر' }, { name: 'El Alia', nameAr: 'العالية' }, { name: 'El-Hadjira', nameAr: 'الحجيرة' }, { name: 'M\'naguer', nameAr: 'المنقر' }, { name: 'Megarine', nameAr: 'المقارين' }, { name: 'Nezla', nameAr: 'النزلة' }, { name: 'Sidi Slimane', nameAr: 'سيدي سليمان' }, { name: 'Taibet', nameAr: 'الطيبات' }, { name: 'Tebesbest', nameAr: 'تبسبست' }, { name: 'Temacine', nameAr: 'تماسين' }, { name: 'Touggourt', nameAr: 'تقرت' }, { name: 'Zaouia El Abidia', nameAr: 'الزاوية العابدية' },
    ],
  },
  {
    code: '56',
    name: 'Djanet',
    nameAr: 'جانت',
    communes: [ { name: 'Bordj El Haouass', nameAr: 'برج الحواس' }, { name: 'Djanet', nameAr: 'جانت' },
    ],
  },
  {
    code: '57',
    name: 'El Meghaier',
    nameAr: 'المغير',
    communes: [ { name: 'Djamaa', nameAr: 'جامعة' }, { name: 'El-M\'ghaier', nameAr: 'المغير' }, { name: 'M\'rara', nameAr: 'المرارة' }, { name: 'Oum Touyour', nameAr: 'أم الطيور' }, { name: 'Sidi Amrane', nameAr: 'سيدي عمران' }, { name: 'Sidi Khelil', nameAr: 'سيدي خليل' }, { name: 'Still', nameAr: 'سطيل' }, { name: 'Tenedla', nameAr: 'تندلة' },
    ],
  },
  {
    code: '58',
    name: 'El Menia',
    nameAr: 'المنيعة',
    communes: [ { name: 'El Meniaa', nameAr: 'المنيعة' }, { name: 'Hassi Fehal', nameAr: 'حاسي الفحل' }, { name: 'Hassi Gara', nameAr: 'حاسي القارة' },
    ],
  },
];

/** Total commune count (baladiyas) — 1541. */
export const ALGERIA_COMMUNE_COUNT = ALGERIA_WILAYAS.reduce((sum, w) => sum + w.communes.length, 0);

/** Wilaya label helper: '16 - Alger' (Latin) or '16 - الجزائر' (Arabic). */
export function wilayaLabel(w: AlgeriaWilaya, lang: string): string {
  return lang === 'ar' ? `${w.code} - ${w.nameAr}` : `${w.code} - ${w.name}`;
}

/** Commune label helper: Latin or Arabic name by language. */
export function communeLabel(c: AlgeriaCommune, lang: string): string {
  return lang === 'ar' ? c.nameAr : c.name;
}

/** Find a wilaya by its official code ('01'..'58', also accepts '1'..'58'). */
export function findWilayaByCode(code: string): AlgeriaWilaya | undefined {
  const normalized = code ? code.padStart(2, '0') : '';
  return ALGERIA_WILAYAS.find((w) => w.code === normalized);
}
