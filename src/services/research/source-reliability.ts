/**
 * Heuristic reliability score (0-1) for a source URL, used to rank references and to
 * decide whether research is strong enough to support a factual script.
 */
const HIGH_TRUST_SUFFIXES = [".gov", ".edu", ".mil", ".int", ".ac.uk", ".gov.uk", ".europa.eu"];
const HIGH_TRUST_DOMAINS = [
  "nasa.gov", "esa.int", "nih.gov", "noaa.gov", "who.int", "nature.com", "science.org", "sciencedirect.com",
  "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "britannica.com", "nationalgeographic.com", "smithsonianmag.com",
  "si.edu", "royalsociety.org", "cell.com", "pnas.org", "nejm.org", "thelancet.com", "bmj.com", "arxiv.org",
  "scientificamerican.com", "newscientist.com", "bbc.co.uk", "bbc.com", "reuters.com", "apnews.com",
  "history.com", "nobelprize.org", "iucnredlist.org", "worldbank.org", "imf.org", "un.org", "ieee.org",
];
const MEDIUM_TRUST_DOMAINS = [
  "wikipedia.org", "space.com", "livescience.com", "sciencealert.com", "phys.org", "theguardian.com",
  "nytimes.com", "washingtonpost.com", "economist.com", "wired.com", "arstechnica.com", "theverge.com",
  "technologyreview.com", "forbes.com", "bloomberg.com", "npr.org", "pbs.org", "sciencedaily.com",
  "popularmechanics.com", "discovermagazine.com", "howstuffworks.com", "investopedia.com",
];
const LOW_TRUST_HINTS = ["reddit.com", "quora.com", "facebook.com", "tiktok.com", "twitter.com", "x.com", "pinterest.", "blogspot.", "medium.com", "fandom.com"];

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function matches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function sourceReliability(url: string): number {
  const host = hostOf(url);
  if (!host) return 0.1;
  if (HIGH_TRUST_DOMAINS.some((d) => matches(host, d))) return 0.95;
  if (HIGH_TRUST_SUFFIXES.some((s) => host.endsWith(s))) return 0.9;
  if (MEDIUM_TRUST_DOMAINS.some((d) => matches(host, d))) return 0.7;
  if (LOW_TRUST_HINTS.some((d) => host.includes(d))) return 0.2;
  return 0.5;
}

export function publisherName(url: string): string {
  return hostOf(url) || url;
}
