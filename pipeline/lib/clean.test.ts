import { describe, expect, it } from "vitest";
import { dedupeArticles, isJunkHeadline, normalizeTitle, titleKey } from "./clean";
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
