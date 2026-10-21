import { describe, expect, it } from "vitest";
import type { Article } from "./googlenews";
import {
  ageHours,
  groupStories,
  HEADLINE_POSITIONS,
  isTrending,
  LEAD_LAG_HOURS,
  outletKey,
  rankMarks,
  rankStories,
  representative,
  SAME_OUTLET_THRESHOLD,
  sameFigures,
  similarity,
  SOFT_PENALTY,
  STORY_THRESHOLD,
  storyScore,
  storyStats,
  storyTokens,
  tokenWeights,
  TRENDING_HOURS,
  TRENDING_MAX,
  TRENDING_OUTLETS,
} from "./trending";

const NOW = "2026-10-21T12:00:00.000Z";
const at = Date.parse(NOW);
/** An ISO time `h` hours before NOW. */
const ago = (h: number) => new Date(at - h * 3_600_000).toISOString();

let n = 0;
function art(title: string, outlet: string, hoursAgo = 1, extra: Partial<Article> = {}): Article {
  return { title, outlet, url: `https://x.example/${++n}`, outletUrl: null, published: ago(hoursAgo), ...extra };
}

describe("storyTokens", () => {
  it("uses words for spaced scripts, ignoring case, punctuation and one-letter words", () => {
    expect(storyTokens("UK weather: Amber warning, it's a STORM!")).toEqual(["uk", "weather", "amber", "warning", "it", "storm"]);
    expect(storyTokens("Шторм «Остин» идёт")).toEqual(["шторм", "остин", "идёт"]);
  });
  it("uses character pairs for Chinese, Japanese, Thai and Korean, and words for the Latin parts", () => {
    expect(storyTokens("国台办回应")).toEqual(["国台", "台办", "办回", "回应"]);
    expect(storyTokens("大阪で30℃")).toEqual(["大阪", "阪で", "30"]);
    expect(storyTokens("ไทยรัฐ")).toEqual(["ไท", "ทย", "ยร", "รั", "ัฐ"]);
    expect(storyTokens("한국 AI 기업")).toEqual(["한국", "ai", "기업"]);
    expect(storyTokens("日")).toEqual(["日"]);
  });
  it("reads a headline split by ' | ' from its longest part", () => {
    expect(storyTokens("Ukraine-Krieg aktuell | Drohnenangriff löst Feuer aus")).toEqual(["drohnenangriff", "löst", "feuer", "aus"]);
    expect(storyTokens("กปภ. เข้ม รับมือฝนตกหนัก | สวพ.FM91")).not.toContain("fm91");
  });
});

describe("similarity and tokenWeights", () => {
  it("is 1 for the same tokens and 0 for none shared", () => {
    expect(similarity(["a1", "b2"], ["b2", "a1"])).toBe(1);
    expect(similarity(["a1"], ["b2"])).toBe(0);
    expect(similarity([], [])).toBe(0);
    expect(similarity(["a1", "b2"], ["a1", "c3"])).toBe(0.5);
  });
  it("weighs rare tokens above common ones", () => {
    const docs = [["the", "storm"], ["the", "budget"], ["the", "vote"]];
    const w = tokenWeights(docs);
    expect(w("storm")).toBeGreaterThan(w("the"));
    // Sharing only "the" counts for less than sharing a rare word.
    expect(similarity(["the", "storm"], ["the", "budget"], w)).toBeLessThan(similarity(["the", "storm"], ["storm", "budget"], w));
  });
});

describe("sameFigures", () => {
  const quake = (time: string) => storyTokens(`Light mag. 3.3 earthquake - Departamento de Potosi, Bolivia, on Tuesday, Oct 20, 2026, at ${time} (GMT -4)`);
  it("compares the tokens that hold digits, in any order", () => {
    expect(sameFigures(quake("06:35 pm"), quake("05:54 am"))).toBe(false);
    expect(sameFigures(storyTokens("Peru vs. Bolivia (Nov 13, 2026) Live Score"), storyTokens("Peru vs. Bolivia (13 Nov, 2026) Live Score"))).toBe(true);
    expect(sameFigures(storyTokens("Alice Schwarzer stellt Magazin „Emma“ ein"), storyTokens("„Es reicht!“: Alice Schwarzer stellt Magazin „Emma“ überraschend ein"))).toBe(true);
  });
});

describe("outletKey", () => {
  it("folds MSN syndication, case and punctuation", () => {
    expect(outletKey("Evening Standard on MSN")).toBe(outletKey("Evening Standard"));
    expect(outletKey("ZEIT ONLINE via MSN")).toBe("zeitonline");
    expect(outletKey("www.BBC.com")).toBe("bbccom");
    expect(outletKey("")).toBe("");
  });
});

// Real headlines from one morning's feeds (21 October 2026), with the
// outlets that ran them, one batch per country edition. Each batch has
// other headlines from the same feeds around the pairs, as a country's
// merged list would, so common words weigh what they do in a real run.
// "same" pairs tell one event and must group; "different" pairs share
// names, topics or an outlet's rubric but are different stories.
type Pair = [outlet: string, title: string, outlet: string, title: string];
interface Batch {
  edition: string;
  others: [outlet: string, title: string][];
  same: Pair[];
  different: Pair[];
}
const BATCHES: Batch[] = [
  {
    edition: "GB:en",
    others: [
      ["BBC", "Masked boy guilty of trying to murder schoolgirl in Norfolk"],
      ["The Argus", "Fireworks event cancelled after 70mph wind weather warnings"],
      ["BBC", "Bereaved daughter says covid care home findings will not change anything"],
      ["BBC", "Hedgehog without prickles made charity ambassador"],
      ["BBC", "Driver who dragged head teacher to death 'sped away from police'"],
      ["BBC", "Decision to delay council tax shake-up in Wales is 'absurd', says IFS"],
      ["POLITICO.eu", "Burnham needs public consent for his EU reset, says Brexit negotiator Barnier"],
      ["STV News", "Gun fired at flat window as police probe 'targeted' attack in Kilmarnock"],
    ],
    same: [["BBC", "UK weather: Amber warning issued by Met Office ahead of Storm Austen", "Sky News", "UK weather: Amber wind warning issued ahead of Storm Austen"]],
    different: [["BBC", "Man charged after Hackney attacks on three Jewish women", "The Independent", "Man, 26, charged with murder after death of woman in Manchester"]],
  },
  {
    edition: "DE:de",
    others: [
      ["WEB.DE", "Umfrage zeigt: Zustimmung zur Zeitumstellung wächst wieder"],
      ["T-Online", '"Rente mit 63": Kompromiss zur abschlagsfreien Frührente hat Folgen für Rentner'],
      ["Spiegel", "Arzttermine: Kassenärzte warnen vor längeren Wartezeiten durch Gesundheitsreform"],
      ["WELT", "CDU-Abgeordneter von Stetten wehrt sich gegen SPD-Kritik an Aussage über Bas"],
      ["rbb24.de", "Demonstranten kleben sich vor Rheinmetall-Firmengelände fest"],
      ["tagesschau.de", "Deutschlands schwindende Anziehungskraft für Investoren"],
      ["FAZ", "Reform der Uni Frankfurt: Präsidium will nur noch sieben Fachbereiche"],
      ["WELT", "„Enorme Zahl an Abbrechern“ – Bildungsminister kritisiert Konzeption von Lehramtsstudium"],
    ],
    same: [
      ["DIE ZEIT", "Klimawandel: Erde steuert laut UN-Bericht auf 2,8 Grad Erwärmung zu", "tagesschau.de", "UN-Bericht: Erde steuert auf 2,8 Grad Erwärmung zu"],
      ["FAZ", "Alice Schwarzer stellt Magazin „Emma“ ein", "FAZ", "„Es reicht!“: Alice Schwarzer stellt Magazin „Emma“ überraschend ein"],
    ],
    different: [["T-Online", "Ukraine-Krieg aktuell: Russland lässt US-Staatsbürger Hubbard frei", "T-Online", "Ukraine-Krieg aktuell | Drohnenangriff löst Feuer an möglicher Druschba-Ölstation aus"]],
  },
  {
    edition: "FR:fr",
    others: [
      ["BFM", "Smic, Parcoursup, services publics: les trois exigences de Sophie Binet qui appelle le Premier ministre à écouter les revendications des jeunes"],
      ["Corse Matin", "Intempéries en Haute-Corse : l'homme emporté par les eaux à Ghisonaccia est décédé"],
      ["La République du Centre", "Congrès du RN à Orléans : inquiétudes autour de la sécurité, des débordements redoutés"],
      ["Libération", "Après le 17 octobre, ce que votre fil d’actualités ne vous montre pas"],
      ["Lyon Capitale", "Rassemblement de l’ultra droite à Lyon : le préfet saisit le procureur pour les propos islamophobes et xénophobes"],
      ["Ouest-France", "Tempête Austen : un fort vent va souffler en deux temps sur les Côtes-d’Armor cette semaine"],
      ["Sud Ouest", "Violences du 17 octobre à Bordeaux : six hommes en répondent ce mardi en comparution immédiate"],
      ["Le Figaro", "Le taux d’emprunt de la France à dix ans franchit la barre symbolique des 5%, une première depuis 2002"],
    ],
    same: [
      [
        "franceinfo",
        "Quatre personnes d'une même famille retrouvées mortes à Toulouse, la thèse d'un triple homicide suivi d'un suicide privilégiée par l'enquête",
        "Le Figaro",
        "Toulouse : quatre personnes d’une même famille décédées, la thèse d’un triple homicide suivi d’un suicide privilégiée",
      ],
    ],
    different: [
      [
        "Le Monde.fr",
        "Mobilisation du 17 octobre : lors des comparutions immédiates, le défilé des auteurs présumés des pillages devant des juges sous pression",
        "Ouest-France",
        "Le dessin de Chaunu : les pillages dans les magasins lors des débordements du 17 octobre",
      ],
    ],
  },
  {
    edition: "BR:pt-419",
    others: [
      ["Estadão", "PF diz que amigo de Flávio Bolsonaro tinha sala secreta para dinheiro vivo em hangar de aviação"],
      ["Revista Oeste", "TSE fecha prazo para registro de novas pesquisas eleitorais"],
      ["Senado Federal", "Jornada de trabalho 5x2 deve entrar em vigor em 15 de dezembro"],
      ["CartaCapital", "TSE diminui para 444 o número seções alteradas no 2º turno"],
      ["G1", "SUS começa a oferecer nove medicamentos contra o câncer; veja quais são e quem pode receber"],
      ["Poder360", "Lula visita Sarney após ato no Maranhão; veja fotos"],
      ["Estadão", "Produtora de filme de Bolsonaro assinou acordo de negócios com operador financeiro do Master"],
      ["revista piauí", "Mais de 70% das interações do celular de Vorcaro com políticos eram com membros do governo Bolsonaro"],
    ],
    same: [
      [
        "G1",
        "Em posts apagados, Flávio Bolsonaro critica Bolsa Família e diz que 'PT perpetua pobreza com bolsa-farelo'",
        "Estadão",
        "Flávio Bolsonaro apaga posts em que criticava Bolsa Família e chamava benefício de ‘bolsa-farelo’",
      ],
    ],
    different: [["UOL Notícias", "Mísseis houthis matam ao menos 53 soldados no Iêmen", "UOL Notícias", "Ataque do Exército sudanês contra mercado deixa ao menos 53 mortos"]],
  },
  {
    edition: "RU:ru",
    others: [
      ["Газета", "В России ужесточат наказание за вождение без прав"],
      ["Lenta News", "Повышение ставок по ипотеке объяснили"],
      ["Lenta News", "Раскрыта особенность запуска дронов ВСУ для атаки на Подмосковье"],
      ["Русская служба The Moscow Times", "Крупнейшая сеть алкомаркетов в России начала готовиться к ударам дронов по складам"],
      ["Ведомости", "Лавров исключил политические уступки в ходе переговоров по Украине"],
      ["47 новостей из Ленинградской области", "Стало известно, кто погиб при атаке БПЛА на Петербург"],
      ["Общественное телевидение Приморья", "Загранпаспорт нового образца вводят с 2027 года"],
      ["EADaily", "США получили доказательства сотрудничества Киева с наркокартелями — СВР"],
    ],
    same: [
      ["Интерфакс", "Первый танкер с российским дизелем отправится в США 22 октября", "ТАСС", "Россия направит первый танкер с дизелем в США 22 октября"],
    ],
    different: [["Ведомости", "Главное из заявлений Пескова о конфликте на Украине и позиции Европы", "Ведомости", "Главное из заявлений Трампа о конфликте на Украине и успехах России"]],
  },
  {
    edition: "TH:th",
    others: [
      ["thestandard.co", "สรุปข้อสงสัยเงินเยียวยาน้ำท่วม กทม. พร้อมกาง 5 เหตุผลทำไมคนกรุงได้เงินช้ากว่าจังหวัดอื่น"],
      ["เดลินิวส์", "น้ำเน่าขยะพิษปราจีนฯ ผลผลิตมรดก “คสช.”"],
      ["Thaipost.net", "อุเทนถวายยังไม่จบ! 'ยศชนัน' นัดหารือ 22 ต.ค."],
      ["สยามรัฐ", "“วราวุธ” สั่งตรวจโรงงานกากอุตสาหกรรมเถื่อนทั่วประเทศ ลุยสอบเส้นเงิน-ยึดทรัพย์"],
      ["The Active", "ไทยเสี่ยงขาดแคลนแรงงานข้ามชาติเฉียบพลัน หลัง รบ.เมียนมา เข้มมาตรการต่ออายุทำงานในไทย"],
      ["thestandard.co", "‘วราวุธ’ ดันเหมืองโพแทชไทย ลดพึ่งพานำเข้าปุ๋ยหมื่นล้าน ชูเป้าฮับส่งออกอาเซียน"],
      ["Thairath.co.th", "เร่งแก้น้ำเสียคลองระพีพัฒน์ 2 อัดน้ำดีช่วยเจือจาง คาดระบายน้ำท่วมขังหมดกลาง พ.ย."],
      ["thestandard.co", "คลังยัน ฐานะการคลังไทยยังแข็งแรง ไม่ซ้ำรอยฝรั่งเศส ชี้มี Buffer สูง ย้ำไม่ก่อหนี้ใหม่โดยไม่จำเป็น"],
    ],
    same: [
      ["Thairath.co.th", "เซเลนสกีเผย สหรัฐฯ กลับมาแชร์ข่าวกรองแล้ว หลังคุยผู้แทนทรัมป์ที่ออสโล", "thestandard.co", "เซเลนสกีเผย สหรัฐฯ กลับมาแชร์ข่าวกรองให้ยูเครนแล้ว หลังคุยทูตพิเศษทรัมป์"],
    ],
    different: [
      ["Thairath.co.th", "ทรัมป์กดดันเซเลนสกีเร่งทำข้อตกลงรัสเซีย ลั่นชาวยูเครนอาจทนสงครามไม่ไหว", "thestandard.co", "เซเลนสกีเผย สหรัฐฯ กลับมาแชร์ข่าวกรองให้ยูเครนแล้ว หลังคุยทูตพิเศษทรัมป์"],
      ["เนชั่นทีวี", "สมาพันธ์เอสเอ็มอีไทย ย้ำไทยหวังขยับสู่ประเทศรายได้สูง ต้องแก้ 2 โจทย์ใหญ่", "เนชั่นทีวี สถานีข่าว 24 ชั่วโมง", "“ยศชนัน” กางยุทธศาสตร์นำไทยสู่ประเทศรายได้สูง ดัน 3 โครงการ"],
    ],
  },
  {
    edition: "JP:ja",
    others: [
      ["読売新聞", "外務省の中村欧州局長が訪露、北海道新聞記者の即時解放を要求"],
      ["日本経済新聞", "iPS細胞心筋シート移植の女性「深い呼吸可能に」 大阪、近く退院"],
      ["47NEWS", "【速報】不正アクセス、22府県警で個人情報流出か"],
      ["テレ朝NEWS", "秋から冬にかけて全国的に「高温」か 過去最強のエルニーニョ現象が影響 気象庁"],
      ["テレ朝NEWS", "大学生の30歳女逮捕 風俗店店長から現金脅し取ったか"],
      ["朝日新聞", "「遺体なき」傷害致死事件 公判で黙秘した被告に懲役12年6カ月 [大阪府]"],
      ["産経ニュース", "飲酒時に「俺たちもやるか」 ベトナム人の男2人、空き巣疑いで逮捕"],
      ["産経ニュース", "生後3カ月の娘を殺害 母親が初公判で起訴内容認める"],
    ],
    same: [["ウェザーニュース", "大阪、東京で史上最も遅い真夏日 明日は気温が大幅に低下", "テレ朝NEWS", "大阪で30℃に到達 統計史上最も遅い真夏日 気象庁"]],
    different: [["テレ朝NEWS", "秋から冬にかけて全国的に「高温」か 過去最強のエルニーニョ現象が影響 気象庁", "ウェザーニュース", "台風22号 週末にかけて沖縄に接近 気象庁"]],
  },
  {
    edition: "KR:ko",
    others: [
      ["한겨레", "브런슨 주한미군사령관 “한미, 1년 내내 훈련해야”"],
      ["MBC 뉴스", "국힘, '우크라 공관원 추가 철수' 결정에 \"대통령, 감정적 대응\""],
      ["조선일보", "중앙선관위 5급 직원, 특검 조사 후 숨진채 발견돼"],
      ["KBS 뉴스", "제주 옛 연인 보복살인 60대 남성 구속"],
      ["경향신문", "공소청, ‘서부지법 폭동 배후 의혹’ 전광훈에 징역 5년 구형"],
      ["MBC 뉴스", "'슈퍼태풍 참피' 한·일 사이로? 美 JTWC 예측 경로 보니"],
      ["연합뉴스TV", "이 대통령 “기존 관행 얽매이지 않고 ’주택 공급 전격전’ 펼쳐야“"],
      ["KBS 뉴스", "충남 천안 한 유치원 건물 옥상서 불…인명피해 없어"],
    ],
    same: [
      ["경향신문", "[단독]이 대통령 “유시민 처벌 원치 않는다” 의사 표시…명예훼손 경찰 수사 종결 수순", "한겨레", "이 대통령 “유시민 처벌 원하지 않는다”…명예훼손 혐의 수사 종결될 듯"],
      ["미주중앙일보", "日구직자 절반 “한국 기업서 일하고 싶다”…74%는 이것 걱정", "중앙일보 on MSN", "日 구직자 절반, “한국 기업서 일하고 싶어요”…성장성에 호감, 수직문화엔 우려"],
    ],
    different: [
      ["경향신문", "[속보]‘내란 가담’ 박성재 전 법무부 장관, 항소심 징역 9년 선고…1심보다 대폭 감형", "한겨레", "박영수 전 특검 항소심서 징역 6년…1심 보다 1년 줄어"],
      ["대한민국 정책브리핑", "우리 발사체로, 더 큰 우주로 - 전체 | 카드/한컷 | 멀티미디어", "대한민국 정책브리핑", "교육부 소관 법령 3건 국무회의 통과 - 전체 | 카드/한컷 | 멀티미디어"],
    ],
  },
  {
    edition: "CN:zh-Hans",
    others: [
      ["第一财经", "超强台风“蔷琵”来袭 国家海洋预报台发布海浪黄色警报"],
      ["RFI", "亚太经合财长会议在港闭幕 共识是增协调以加强财金系统韧性 保区域稳定"],
      ["中国藏族网通", "甘南州：耳畔洮水悠悠 心中烽火灼灼"],
      ["首都文明网", "金海湖镇开展社保服务进万家主题宣传活动"],
      ["新京报", "《2026中国出海品牌500强》：北京头部最强，广东数量领跑"],
      ["新华社广西分社", "冷空气将影响广西 带来降温降雨天气 桂北最低气温将跌至“1字头”"],
      ["中国政协网", "党建引领 协商为民"],
      ["人民网财经", "草原云谷培育智算热土--经济·科技"],
    ],
    same: [],
    different: [["中华军事", "国台办回应IMF将台湾列为中国一省 民进党当局跳脚遭批", "中华网", "民进党当局拒绝艺人张凌赫赴台交流 国台办回应"]],
  },
];

describe.each(BATCHES)("groupStories on the $edition edition", ({ others, same, different }) => {
  const pairs = [...same, ...different];
  const batch = [...others, ...pairs.flatMap(([o1, t1, o2, t2]): [string, string][] => [[o1, t1], [o2, t2]])]
    .filter(([, t], i, all) => all.findIndex(([, u]) => u === t) === i)
    .map(([o, t]) => art(t, o));
  const groups = groupStories(batch);
  const together = (a: string, b: string) => groups.some((g) => g.some((x) => x.title === a) && g.some((x) => x.title === b));

  if (same.length) {
    it.each(same)("groups the same event: %s", (_o1, t1, _o2, t2) => {
      expect(together(t1, t2)).toBe(true);
    });
  }
  it.each(different)("keeps different stories apart: %s", (_o1, t1, _o2, t2) => {
    expect(together(t1, t2)).toBe(false);
  });
  it("leaves every other headline on its own", () => {
    for (const [, t] of others) expect(groups.find((g) => g.some((x) => x.title === t))).toHaveLength(1);
  });
});

describe("groupStories", () => {
  const [o1, t1, o2, t2] = BATCHES[0].same[0];
  it("keeps the input order of each story's first article", () => {
    const a = art("Hedgehog without prickles made charity ambassador", "BBC");
    const groups = groupStories([art(t1, o1), a, art(t2, o2)]);
    expect(groups.map((g) => g.map((x) => x.title))).toEqual([[t1, t2], [a.title]]);
  });
  it("never groups headlines more than two days apart", () => {
    expect(groupStories([art(t1, o1, 1), art(t2, o2, 60)])).toHaveLength(2);
  });
  it("keeps one outlet's templated headlines apart when their figures differ", () => {
    // Bolivia's world coverage on 21 October 2026: Volcano Discovery reports
    // every quake with one template, so two quakes score above the
    // same-outlet bar, while ESPN's two pages for one match share their figures.
    const quake = (time: string) => `Light mag. 3.3 earthquake - Departamento de Potosi, Bolivia, on Tuesday, Oct 20, 2026, at ${time} (GMT -4)`;
    const batch = [
      art("Bolivia Lawmakers Demand Orobe Into Alleged Plot to Abduct Evo Morales", "teleSUR English"),
      art("Bolivia sets 15% ethanol blend by Nov. 1 to slash its ballooning gasoline import bill", "Latin Times"),
      art("Bolivia prioritizes two rail projects with Chile after presidential talks", "BNamericas"),
      art("Gold fever closes in on the habitat of the tilcayo, Bolivia’s newly discovered wild cat", "EL PAÍS English"),
      art("Global Unrest: Bolivia Teachers Clash With Authorities as Tear Gas and Pepper Spray Fill Streets", "ABP Live English"),
      art("Bolivia's Fuel Import Volume Drops 28% While Costs Remain Flat", "PravdaReport"),
      art("Croatian community in Bolivia holds cultural week in La Paz", "HINA"),
      art("Light mag. 3.5 earthquake - Provincia de El Loa, Chile, on Wednesday, Oct 21, 2026, at 03:44 am (GMT -4)", "Volcano Discovery", 4),
      art("Peru vs. Bolivia (Nov 13, 2026) Live Score", "ESPN", 54),
      art("Peru vs. Bolivia (13 Nov, 2026) Live Score", "ESPN", 52),
      art(quake("06:35 pm"), "Volcano Discovery", 17),
      art(quake("05:54 am"), "Volcano Discovery", 25),
    ];
    const tokens = batch.map((a) => storyTokens(a.title));
    expect(similarity(tokens[10], tokens[11], tokenWeights(tokens))).toBeGreaterThan(SAME_OUTLET_THRESHOLD);
    const groups = groupStories(batch).map((g) => g.map((a) => a.title));
    expect(groups).toHaveLength(batch.length - 1);
    expect(groups).toContainEqual([batch[8].title, batch[9].title]);
  });
  it("uses a threshold between the scores of different and same stories", () => {
    expect(STORY_THRESHOLD).toBeGreaterThan(0.3);
    expect(STORY_THRESHOLD).toBeLessThan(0.5);
  });
});

describe("storyStats and representative", () => {
  const top = new Map([
    ["https://top/a", 4],
    ["https://top/b", 1],
  ]);
  const story = [
    art("Storm Austen nears", "BBC", 3, { url: "https://top/a", related: ["The Guardian", "Sky News"] }),
    art("Storm Austen: amber warning", "Sky News", 1, { related: ["BBC", "ITV News"] }),
    art("Amber warning for Storm Austen", "The Guardian on MSN", 2, { url: "https://top/b" }),
  ];
  it("counts distinct outlets, including Google's related coverage, the newest time and the best position", () => {
    expect(storyStats(story, top)).toEqual({ outlets: 4, newest: ago(1), topPosition: 1, soft: false });
    expect(storyStats([art("Alone", "", 2)], new Map())).toEqual({ outlets: 1, newest: ago(2), topPosition: null, soft: false });
  });
  it("calls a story soft when one of its links is labelled soft and none hard", () => {
    const soft = new Set(["https://top/a"]);
    expect(storyStats(story, top, new Set(), soft).soft).toBe(true);
    expect(storyStats(story, top, new Set(["https://top/b"]), soft).soft).toBe(false);
    expect(storyStats(story, top, new Set(["https://top/a"]), soft).soft).toBe(false);
  });
  it("shows the best-placed top-stories article, else the newest", () => {
    expect(representative(story, top).outlet).toBe("The Guardian on MSN");
    expect(representative(story, new Map()).outlet).toBe("Sky News");
  });
  it("passes over a top-stories article much older than the story's newest", () => {
    const lead = art("Storm Austen: Amber warning issued by Met Office for wind", "BBC", 40, { url: "https://top/old" });
    const update = art("Storm Austen: Amber wind warning issued by Met Office extended", "The Telegraph", 1);
    expect(representative([lead, update], new Map([["https://top/old", 0]]))).toBe(update);
    const recent = { ...lead, published: ago(1 + LEAD_LAG_HOURS) };
    expect(representative([recent, update], new Map([["https://top/old", 0]]))).toBe(recent);
  });
});

describe("ageHours", () => {
  it("reads hours since publishing, treating far-future or bad times as stale", () => {
    expect(ageHours(ago(2), at)).toBeCloseTo(2);
    expect(ageHours(ago(-0.5), at)).toBe(0); // a little clock skew is fine
    expect(ageHours(ago(-24), at)).toBe(Infinity);
    expect(ageHours("not a date", at)).toBe(Infinity);
  });
});

describe("storyScore", () => {
  const score = (outlets: number, hoursAgo: number, topPosition: number | null = null, soft = false) =>
    storyScore({ outlets, newest: ago(hoursAgo), topPosition, soft }, at);
  it("puts a fresh story carried by many outlets above an old top-stories item", () => {
    expect(score(8, 1)).toBeGreaterThan(score(1, 20, 0));
    expect(score(8, 1)).toBeGreaterThan(score(5, 20, 0));
  });
  it("drops a day-old story below fresh ones", () => {
    expect(score(5, 24, 3)).toBeLessThan(score(3, 2, 15));
    expect(score(5, 24, 3)).toBeLessThan(score(4, 3));
  });
  it("keeps Google's leading story above a fresh single-outlet item while it is fresh", () => {
    expect(score(1, 2, 3)).toBeGreaterThan(score(1, 0.5));
    expect(score(5, 0.5, 0)).toBeGreaterThan(score(5, 0.5, 10));
  });
  it("sinks stories older than a day and a half, and stories dated in the future", () => {
    expect(score(8, 40, 0)).toBeLessThan(score(1, 4));
    expect(score(5, -48, 0)).toBeLessThan(score(1, 4));
  });
  it("prefers more outlets, all else equal", () => {
    expect(score(5, 3)).toBeGreaterThan(score(2, 3));
    expect(score(2, 3)).toBeGreaterThan(score(1, 3));
  });
  it("takes SOFT_PENALTY off soft news, sinking a new phone story below a half-day-old headline but not below stale news", () => {
    expect(score(5, 1, 0, true)).toBeCloseTo(score(5, 1, 0) - SOFT_PENALTY);
    // Thai edition, 21 October 2026: the OPPO leak at top-stories place 19, 40 minutes old, and a 12-hour-old headline.
    expect(score(4, 0.7, 19, true)).toBeLessThan(score(5, 12, 5));
    expect(score(4, 0.7, 19)).toBeGreaterThan(score(5, 12, 5));
    expect(score(4, 0.7, 19, true)).toBeGreaterThan(score(8, 40, 0));
  });
});

describe("isTrending", () => {
  const stats = { outlets: TRENDING_OUTLETS, newest: ago(TRENDING_HOURS - 0.5), topPosition: HEADLINE_POSITIONS - 1, soft: false };
  it("needs four outlets, a headline from the last six hours and a place among Google's ten headlines", () => {
    expect([TRENDING_OUTLETS, TRENDING_HOURS, HEADLINE_POSITIONS]).toEqual([4, 6, 10]);
    expect(isTrending(stats, at)).toBe(true);
    expect(isTrending({ ...stats, outlets: TRENDING_OUTLETS - 1 }, at)).toBe(false);
    expect(isTrending({ ...stats, newest: ago(TRENDING_HOURS + 0.5) }, at)).toBe(false);
    expect(isTrending({ ...stats, topPosition: HEADLINE_POSITIONS }, at)).toBe(false);
  });
  it("never marks soft news, or a story outside the top stories, as all world coverage is", () => {
    expect(isTrending({ ...stats, soft: true }, at)).toBe(false);
    expect(isTrending({ ...stats, outlets: 9, newest: ago(1), topPosition: null }, at)).toBe(false);
  });
});

describe("rankMarks", () => {
  it("copies the outlet count and trending mark when present", () => {
    expect(rankMarks({ outlets: 3, trending: false })).toEqual({ outlets: 3, trending: false });
    expect(rankMarks({})).toEqual({});
  });
});

describe("rankStories", () => {
  it("returns one article per story, best first, with outlets and trending, and no related names", () => {
    const old = art("Parliament passes budget after long debate", "BBC", 20, { url: "https://top/0" });
    const fresh = art("Storm Austen brings amber wind warning to the north", "Sky News", 1, { related: ["BBC", "The Guardian", "ITV News"] });
    const same = art("Amber wind warning as Storm Austen hits the north", "The Telegraph", 2);
    const lone = art("Hedgehog without prickles becomes charity ambassador", "BBC", 2);
    const out = rankStories([old, fresh, same, lone], ["https://top/0", fresh.url], NOW);
    expect(out.map((a) => a.title)).toEqual([fresh.title, lone.title, old.title]);
    expect(out[0]).toMatchObject({ outlets: 5, trending: true });
    expect(out[1]).toMatchObject({ outlets: 1, trending: false });
    expect(out.every((a) => !("related" in a))).toBe(true);
  });
  it("shows a fresh story with its fresh headline, not an old top-stories lead", () => {
    const lead = art("Storm Austen: Amber warning issued by Met Office for wind", "BBC", 40, {
      url: "https://top/old",
      related: ["Sky News", "ITV News", "The Guardian"],
    });
    const update = art("Storm Austen: Amber wind warning issued by Met Office extended", "The Telegraph", 1);
    const out = rankStories([lead, update], ["https://top/old"], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ url: update.url, published: ago(1), outlets: 5, trending: true });
  });
  const many = Array.from({ length: TRENDING_MAX + 3 }, (_, i) =>
    art(`Distinct event number ${i} ${"abcdefghij"[i]}x`, `Outlet ${i}`, 1 + i / 10, { related: ["A", "B", "C"] }),
  );
  it("marks at most TRENDING_MAX stories as trending, the best-ranked ones", () => {
    const out = rankStories(many, many.map((a) => a.url), NOW);
    expect(TRENDING_MAX).toBe(3);
    expect(out.filter((a) => a.trending)).toHaveLength(TRENDING_MAX);
    expect(out.slice(0, TRENDING_MAX).every((a) => a.trending)).toBe(true);
  });
  it("marks nothing trending without top stories, as for world coverage", () => {
    expect(rankStories(many, [], NOW).some((a) => a.trending)).toBe(false);
  });
  it("sinks soft stories and never marks them trending, unless one of their links is hard", () => {
    const phone = art("New phone gets a bigger camera and battery", "Gadget Blog", 0.5, { related: ["Phone News", "Specs Daily", "Tech Hub"] });
    const news = art("Cabinet approves the flood relief budget", "Matichon", 4, { related: ["Thai PBS", "Thairath", "Khaosod"] });
    const top = [phone.url, news.url];
    expect(rankStories([phone, news], top, NOW).map((a) => [a.url, a.trending])).toEqual([
      [phone.url, true],
      [news.url, true],
    ]);
    expect(rankStories([phone, news], top, NOW, { hard: [], soft: [phone.url] }).map((a) => [a.url, a.trending])).toEqual([
      [news.url, true],
      [phone.url, false],
    ]);
    expect(rankStories([phone, news], top, NOW, { hard: [phone.url], soft: [phone.url] })[0].url).toBe(phone.url);
  });
  it("keeps the input order for equal scores, and handles an empty list", () => {
    const a = art("First story about rain", "A", 2);
    const b = art("Second story about trains", "B", 2);
    expect(rankStories([a, { ...b, published: a.published }], [], NOW).map((x) => x.title)).toEqual([a.title, b.title]);
    expect(rankStories([], [], NOW)).toEqual([]);
  });
});
