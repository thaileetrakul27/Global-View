import { describe, expect, it } from "vitest";
import { dedupeArticles, isJunkHeadline, normalizeTitle, titleKey, usableArticles } from "./clean";
import type { Article } from "./googlenews";

function art(url: string, title: string): Article {
  return { url, title, outlet: "Outlet", outletUrl: null, published: "2026-10-18T00:00:00.000Z" };
}

describe("normalizeTitle and titleKey", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normalizeTitle("Budget  passes: after late-night vote!")).toBe("budget passes after late night vote");
    expect(normalizeTitle("“Budget passes” — after vote")).toBe("budget passes after vote");
  });
  it("ignores spacing in the key, which matters for Thai", () => {
    expect(titleKey("สภาผ่านงบประมาณหลังอภิปรายดึก")).toBe(titleKey("สภาผ่านงบประมาณ หลังอภิปรายดึก!"));
    expect(titleKey("Budget passes")).toBe("budgetpasses");
  });
});

describe("isJunkHeadline", () => {
  it("keeps headlines in scripts that use combining marks", () => {
    expect(isJunkHeadline("ฝรั่งเศสประกาศเคอร์ฟิวในปารีส-นีส หลังเกิดเหตุจลาจล")).toBe(false);
    expect(isJunkHeadline("কক্সবাজারে পর্যটকদের ভিড়, হোটেল-মোটেলে ঠাঁই নেই")).toBe(false);
    expect(isJunkHeadline("'เท้ง' กระต่ายขาเดียว ต้องซักฟอก 5 วัน จี้ 'ปธ.สภา' ประชุมวิป")).toBe(false);
    expect(isJunkHeadline("الحكومة تُعلن خطة جديدة لدعم الأسر الفقيرة")).toBe(false);
  });
  it("keeps headlines that use the quotes, brackets and dots of their own language", () => {
    // Real headlines from 21 October 2026 that once counted as junk.
    expect(isJunkHeadline("iPS細胞心筋シート移植の女性「深い呼吸可能に」 大阪、近く退院")).toBe(false);
    expect(isJunkHeadline("【速報】不正アクセス、22府県警で個人情報流出か")).toBe(false);
    expect(isJunkHeadline("陸自〝思想調査〟問題 小泉防衛相、BSD報告書が存在するか答え避ける 「出所、真正性確認できない」")).toBe(false);
    expect(
      isJunkHeadline(
        "「ショウリンジ」と交番や110番で叫ぶなど迷惑行為「少林寺レーシング」で兵庫県内の小学生から18歳25人を検挙・補導 兵庫県警 「遊び感覚でやった・うまく動画撮れず2回侵入」など話す SNS投稿模倣か（関西テレビ）",
      ),
    ).toBe(false);
    expect(isJunkHeadline("《习近平党建文选》第一卷丨（45）不断开辟当代中国马克思主义、二十一世纪马克思主义新境界")).toBe(false);
    expect(isJunkHeadline("[속보] ‘탈북어민 강제북송’ 정의용·서훈, 2심서 징역형 집행유예")).toBe(false);
    expect(
      isJunkHeadline("EN DIRECT, guerre en Ukraine : l’émissaire américain Steve Witkoff va présenter à Vladimir Poutine des « idées claires » pour « parvenir à la paix », selon Volodymyr Zelensky"),
    ).toBe(false);
    expect(isJunkHeadline("Умер актер Владислав Толдыков — звезда фильмов «Жить», «Майор» и «Метод»")).toBe(false);
    expect(isJunkHeadline("«لن نسمح بالعبث بالمهنة».. تحرك عاجل من «التمريض» بعد تصريحات وزير التربية والتعليم")).toBe(false);
  });
  it("keeps headlines with invisible format characters", () => {
    // Soft hyphens (Die Rheinpfalz), zero-width spaces (Thai PBS) and Persian's zero-width non-joiner.
    expect(isJunkHeadline("Schwe\u00adrer Un\u00adfall auf B10 bei Land\u00adau: Mo\u00adtor\u00adrad\u00adfah\u00adrer in Kli\u00adnik ge\u00adflo\u00adgen")).toBe(false);
    expect(isJunkHeadline('"ทรงศักดิ์"\u200b จ่อนัดประชุม\u200b 5 จังหวัดอีสานตอนบน\u200b ชงโครงการเข้า ครม.สัญจรอุดรฯ\u200b')).toBe(false);
    expect(isJunkHeadline("ایران می\u200cگوید مذاکرات هسته\u200cای ادامه می\u200cیابد")).toBe(false);
  });
  it("catches stream spam and leaves real headlines alone", () => {
    expect(isJunkHeadline("+[#!LIVESTREAMs!]™ Fiji vs Cook Islands Live Free Oct 18")).toBe(true);
    expect(isJunkHeadline("Watch Luxembourg vs Bulgaria live stream")).toBe(true);
    expect(isJunkHeadline("[YouTube/LIVE] Cook Islands vs Fiji 𝐋𝐈𝐕𝐄 𝐒𝐭𝐫𝐞𝐚𝐦 Ｔｖ")).toBe(true);
    expect(isJunkHeadline("̳!$[LIVE!#NOW]*Fiji v Cook Islands 𝕃𝕚𝕧𝕖 Ｆｒｅｅ Ｓｔｒｅａｍｓ")).toBe(true);
    expect(isJunkHeadline("[WATCHLIVE]TODAY!] Cook Islands vs Fiji 𝐋𝐈𝐕𝐄 Ｓｔｒｅａｍｓ")).toBe(true);
    expect(isJunkHeadline("√(RUGBY-WC-@LIVE) FIJI - COOK ISLANDS RUGBY LIVE 18-09.")).toBe(true);
    expect(isJunkHeadline("[CBS TV ]] Fiji Cook Islands Rugby 𝐋𝐈𝐕𝐄 Rugby League")).toBe(true);
    expect(isJunkHeadline("**%[[[𝑺𝑷𝑶𝑹𝑻 Fiji vs Cook Islands")).toBe(true);
    expect(isJunkHeadline("&𝐖𝐀𝐓𝐂𝐇@ Cook Islands vs Fiji Live Rugby League")).toBe(true);
    expect(isJunkHeadline("Fiji beat Cook Islands 24-10 in Pacific Championship")).toBe(false);
    expect(isJunkHeadline("LIVE: Protests spread across France as unions call strike")).toBe(false);
    expect(isJunkHeadline("🇲🇳 Mongolia: Beck changes song for Eurovision Asia")).toBe(false);
    expect(isJunkHeadline("“No to torture!” Saturday march in Tbilisi (photos)")).toBe(false);
    expect(isJunkHeadline("Mongolia becomes new donor to World Bank fund")).toBe(false);
    expect(isJunkHeadline("Protests live: thousands march in Paris")).toBe(false);
  });
});

describe("usableArticles", () => {
  it("drops repeated urls, blank headlines and junk, but keeps repeated headlines", () => {
    const kept = usableArticles([
      art("u1", "Budget passes"),
      art("u2", "BUDGET PASSES!"),
      art("u1", "Something else"),
      art("u5", "   "),
      art("", "No link"),
      art("u6", "Team A vs Team B live stream free"),
    ]);
    expect(kept.map((a) => a.url)).toEqual(["u1", "u2"]);
  });
});

describe("dedupeArticles", () => {
  it("drops duplicate urls and near-duplicate headlines, keeping the first", () => {
    const kept = dedupeArticles([
      art("u1", "Budget passes"),
      art("u2", "BUDGET PASSES!"),
      art("u1", "Something else"),
      art("u3", "Other story"),
      art("u4", "Other  story"),
      art("u5", "   "),
      art("u6", "Team A vs Team B live stream free"),
    ]);
    expect(kept.map((a) => a.url)).toEqual(["u1", "u3"]);
  });
});
