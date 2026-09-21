/** Lookups for the public site. Values are labels only — no data is invented here. */

export const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands', AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
};

/** NAICS two-digit sectors, with the ranged sectors expanded to each code. */
export const NAICS_SECTORS: Record<string, string> = {
  '11': 'Agriculture, Forestry, Fishing and Hunting',
  '21': 'Mining, Quarrying, and Oil and Gas Extraction',
  '22': 'Utilities',
  '23': 'Construction',
  '31': 'Manufacturing', '32': 'Manufacturing', '33': 'Manufacturing',
  '42': 'Wholesale Trade',
  '44': 'Retail Trade', '45': 'Retail Trade',
  '48': 'Transportation and Warehousing', '49': 'Transportation and Warehousing',
  '51': 'Information',
  '52': 'Finance and Insurance',
  '53': 'Real Estate and Rental and Leasing',
  '54': 'Professional, Scientific, and Technical Services',
  '55': 'Management of Companies and Enterprises',
  '56': 'Administrative and Support and Waste Management',
  '61': 'Educational Services',
  '62': 'Health Care and Social Assistance',
  '71': 'Arts, Entertainment, and Recreation',
  '72': 'Accommodation and Food Services',
  '81': 'Other Services (except Public Administration)',
  '92': 'Public Administration',
};

export interface Program { slug: string; name: string; short: string; blurb: string }

/**
 * Set-aside programs, keyed by the SetASideCode values observed in the live
 * extract. Grouping sole-source with set-aside under one programme is
 * deliberate: a bidder searching "8(a)" wants both.
 */
export const PROGRAMS: Program[] = [
  {
    slug: 'small-business', name: 'Small Business Set-Aside', short: 'Small Business',
    blurb: 'Reserved for any concern that qualifies as a small business under the solicitation’s NAICS size standard.',
  },
  {
    slug: 'sdvosb', name: 'Service-Disabled Veteran-Owned Small Business', short: 'SDVOSB',
    blurb: 'Reserved for service-disabled veteran-owned small businesses under FAR 19.14.',
  },
  {
    slug: 'wosb', name: 'Women-Owned Small Business', short: 'WOSB / EDWOSB',
    blurb: 'Reserved for SBA-certified women-owned and economically disadvantaged women-owned small businesses under FAR 19.15.',
  },
  {
    slug: '8a', name: '8(a) Business Development Program', short: '8(a)',
    blurb: 'Reserved for firms in SBA’s 8(a) Business Development Program under FAR 19.8.',
  },
  {
    slug: 'hubzone', name: 'HUBZone Set-Aside', short: 'HUBZone',
    blurb: 'Reserved for certified Historically Underutilized Business Zone firms under FAR 19.13.',
  },
  {
    slug: 'vosb', name: 'Veteran-Owned Small Business', short: 'VOSB',
    blurb: 'Reserved for veteran-owned small businesses, specific to the Department of Veterans Affairs.',
  },
  {
    slug: 'native', name: 'Indian Small Business Economic Enterprise', short: 'ISBEE / IEE',
    blurb: 'Reserved under the Buy Indian Act for Indian-owned economic enterprises.',
  },
];

const BY_CODE: Record<string, string> = {
  SBA: 'small-business', SBP: 'small-business',
  SDVOSBC: 'sdvosb', SDVOSBS: 'sdvosb',
  WOSB: 'wosb', WOSBSS: 'wosb', EDWOSB: 'wosb', EDWOSBSS: 'wosb',
  '8A': '8a', '8AN': '8a',
  HZC: 'hubzone', HZS: 'hubzone',
  VSA: 'vosb', VSS: 'vosb',
  ISBEE: 'native', IEE: 'native', BICiv: 'native',
};

/**
 * Maps a notice to a programme slug. Falls back to matching the human label,
 * because the code column is occasionally blank in the feed while the label is
 * populated. Returns null when neither identifies a known programme — the page
 * then omits it rather than guessing.
 */
export function programSlug(code: string, label: string): string | null {
  const byCode = BY_CODE[code.trim()];
  if (byCode) return byCode;

  const l = label.toLowerCase();
  if (l.includes('service-disabled')) return 'sdvosb';
  if (l.includes('women-owned')) return 'wosb';
  if (l.includes('8(a)')) return '8a';
  if (l.includes('hubzone')) return 'hubzone';
  if (l.includes('veteran-owned')) return 'vosb';
  if (l.includes('indian')) return 'native';
  if (l.includes('small business')) return 'small-business';
  return null;
}

export function sectorName(naics: string): string | null {
  return NAICS_SECTORS[naics.slice(0, 2)] ?? null;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
