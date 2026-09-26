import { describe, expect, it } from "vitest";
import { analyzeLanguage, analyzeList, assertEnglish, validateBundle } from "@/services/language/language-service";
import { LanguageValidationError } from "@/lib/errors";

const ENGLISH_SCRIPT =
  "Astronauts actually grow up to two inches taller in space. Why? On Earth, gravity constantly squeezes the discs in your spine. " +
  "In orbit, that pressure disappears, so the discs expand and the spine lengthens. The catch is that it does not last. " +
  "Within a few months of returning home, gravity pulls them right back to their normal height.";

describe("LanguageService", () => {
  it("accepts a natural English script", () => {
    const result = analyzeLanguage(ENGLISH_SCRIPT, "script");
    expect(result.isEnglish).toBe(true);
    expect(result.metrics.englishWordRatio).toBeGreaterThan(0.9);
  });

  it.each([
    ["Estonian", "Astronaudid kasvavad kosmoses kuni viis sentimeetrit pikemaks, sest gravitatsioon ei suru nende selgroogu kokku. See on tõesti hämmastav nähtus."],
    ["Latvian", "Astronauti kosmosā izaug garāki, jo gravitācija vairs nespiež viņu mugurkaulu. Tas ir patiešām pārsteidzošs fakts par cilvēka ķermeni."],
    ["Russian", "Космонавты становятся выше в космосе, потому что гравитация больше не сжимает их позвоночник."],
    ["German", "Astronauten werden im Weltraum größer, weil die Schwerkraft ihre Wirbelsäule nicht mehr zusammendrückt. Das ist wirklich erstaunlich."],
    ["Finnish", "Astronautit kasvavat avaruudessa pidemmiksi, koska painovoima ei enää puristaa heidän selkärankaansa kasaan. Tämä on todella hämmästyttävää."],
    ["Spanish", "Los astronautas crecen en el espacio porque la gravedad ya no comprime su columna vertebral. Es realmente sorprendente."],
  ])("rejects %s text", (_lang, text) => {
    const result = analyzeLanguage(text, "script");
    expect(result.isEnglish).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it.each([
    "In 1969, Neil Armstrong and Buzz Aldrin landed Apollo 11 at Tranquility Base while Michael Collins orbited above in Columbia.",
    "Café culture in Paris began in the 1680s, when Procopio Cutò opened Le Procope.",
    "ChatGPT, Claude and Gemini are large language models trained on huge datasets.",
    "Octopuses have three hearts, blue blood, and neurons in their arms. Crazy, right? Follow for more!",
  ])("does not reject English prose with proper nouns: %s", (text) => {
    expect(analyzeLanguage(text, "script").isEnglish).toBe(true);
  });

  it("catches a single non-English sentence hidden in an English script", () => {
    const mixed = `${ENGLISH_SCRIPT} Das ist wirklich eine unglaubliche Geschichte über den Weltraum und die Wissenschaft.`;
    const result = analyzeLanguage(mixed, "script");
    expect(result.isEnglish).toBe(false);
    expect(result.metrics.nonEnglishSentences.length).toBe(1);
  });

  it("validates short titles", () => {
    expect(analyzeLanguage("Why Astronauts Grow Taller in Space", "title").isEnglish).toBe(true);
    expect(analyzeLanguage("Miks astronaudid kosmoses pikemaks kasvavad", "title").isEnglish).toBe(false);
    expect(analyzeLanguage("Почему космонавты растут", "title").isEnglish).toBe(false);
  });

  it("validates hashtags including CamelCase", () => {
    expect(analyzeList(["#SpaceFacts", "#Astronauts", "#Science", "#shorts"], "hashtags").isEnglish).toBe(true);
    expect(analyzeList(["#Kosmos", "#Космос", "#Science"], "hashtags").isEnglish).toBe(false);
  });

  it("assertEnglish throws a retryable LanguageValidationError", () => {
    expect(() => assertEnglish("Esto no es inglés en absoluto, amigo mío de la ciudad.", "title")).toThrow(
      LanguageValidationError,
    );
    try {
      assertEnglish("Esto no es inglés en absoluto, amigo mío de la ciudad.", "title");
    } catch (error) {
      expect((error as LanguageValidationError).retryable).toBe(true);
    }
  });

  it("validates a full bundle and names failing fields", () => {
    const report = validateBundle({
      script: ENGLISH_SCRIPT,
      title: "Why Astronauts Grow Taller in Space",
      description: "Astronaudid kasvavad kosmoses pikemaks. See on hämmastav nähtus, mida teadlased uurivad.",
      hashtags: ["#Space", "#Science"],
    });
    expect(report.passed).toBe(false);
    expect(report.failedFields).toEqual(["description"]);
  });
});
