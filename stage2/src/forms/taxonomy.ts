export interface TaxonomyEntry {
  key: string;
  aliases: RegExp[];
  autocomplete?: string[];
  safeThreshold?: number;
  /**
   * When set, this entry only wins a tie against another entry's matching
   * `sectionScope` group if the field's section/container text matches this
   * pattern. Used to disambiguate identical bare labels ("Start date month")
   * that repeat verbatim across an Employment block and an Education block.
   */
  sectionScope?: RegExp;
}

const exact = (value: string) => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

export const TAXONOMY: TaxonomyEntry[] = [
  { key: "legal_first_name", aliases: [exact("first name"), exact("given name"), /^legal first name$/i], autocomplete: ["given-name"] },
  { key: "legal_middle_name", aliases: [exact("middle name"), exact("middle initial")], autocomplete: ["additional-name"] },
  { key: "legal_last_name", aliases: [exact("last name"), exact("family name"), exact("surname")], autocomplete: ["family-name"] },
  { key: "legal_full_name", aliases: [exact("full name"), exact("legal name"), exact("name")], autocomplete: ["name"], safeThreshold: 0.99 },
  { key: "preferred_first_name", aliases: [/^preferred (first )?name$/i, /^nickname$/i] },
  { key: "primary_email", aliases: [/^(primary )?e-?mail( address)?$/i], autocomplete: ["email"] },
  { key: "mobile_phone", aliases: [/^(mobile |cell )?(phone|telephone)( number)?$/i], autocomplete: ["tel", "tel-national"] },
  { key: "phone_country_code", aliases: [/^(phone )?country code$/i], autocomplete: ["tel-country-code"] },
  { key: "physical_address_line1", aliases: [/^(street )?address( line 1)?$/i, /^address 1$/i], autocomplete: ["street-address", "address-line1"] },
  { key: "physical_address_line2", aliases: [/^address( line)? 2$/i, /^(apartment|suite|unit)$/i], autocomplete: ["address-line2"] },
  { key: "physical_city", aliases: [/^(city|town)$/i, /^location city$/i], autocomplete: ["address-level2"] },
  { key: "physical_state", aliases: [/^(state|province|region)$/i], autocomplete: ["address-level1"] },
  { key: "physical_postal_code", aliases: [/^(zip|zip code|postal code)$/i], autocomplete: ["postal-code"] },
  { key: "physical_country", aliases: [/^(country|country of residence)$/i], autocomplete: ["country", "country-name"] },
  { key: "current_location_display", aliases: [/^current location$/i, /^location$/i], safeThreshold: 0.96 },
  { key: "linkedin_url", aliases: [/linkedin( profile)?( url)?/i] },
  { key: "github_url", aliases: [/github( profile)?( url)?/i] },
  { key: "portfolio_url", aliases: [/(portfolio|personal website|website)( url)?/i] },
  { key: "years_professional_experience", aliases: [/years? of (professional )?experience/i] },
  { key: "authorized_to_work_current", aliases: [/authorized to work/i, /legally (eligible|authorized) to work/i], safeThreshold: 0.95 },
  { key: "need_sponsorship_now", aliases: [/require.*sponsorship.*(now|currently)/i, /need.*sponsorship.*(now|currently)/i], safeThreshold: 0.97 },
  { key: "need_sponsorship_future", aliases: [/(now or in the future|future).*sponsorship/i, /sponsorship.*(future|later)/i], safeThreshold: 0.97 },
  { key: "willing_to_relocate", aliases: [/willing.*relocat/i] },
  { key: "willing_to_onsite", aliases: [/willing.*(onsite|on-site|office)/i] },
  { key: "ready_start_date", aliases: [/(available|availability|start) date/i] },
  { key: "start_availability_text", aliases: [/when can you start/i, /notice period/i] },
  { key: "desired_base_salary", aliases: [/(desired|expected).*salary/i, /salary expectation/i], safeThreshold: 0.96 },
  { key: "how_heard_about_job", aliases: [/how did you hear/i, /source.*application/i] },
  { key: "age_18_or_over", aliases: [/^are you at least 18 years of age$/i, /^18 years of age or older$/i] },
  { key: "previous_employee_of_company", aliases: [/^have you previously been employed by .+ in any capacity$/i, /^previously employed by (this|the) company$/i] },
  { key: "employer_name", aliases: [/^(employer|company|company name)$/i], sectionScope: /employ|work experience|job/i },
  { key: "position_title", aliases: [/^(job title|position title|role title|title)$/i], sectionScope: /employ|work experience|job/i },
  { key: "company_location", aliases: [/^(company|job|employment) location$/i], sectionScope: /employ|work experience|job/i },
  { key: "start_month", aliases: [/^(employment |job )?start( date)? month$/i], sectionScope: /employ|work experience|job/i },
  { key: "start_year", aliases: [/^(employment |job )?start( date)? year$/i], sectionScope: /employ|work experience|job/i },
  { key: "end_month", aliases: [/^(employment |job )?end( date)? month$/i], sectionScope: /employ|work experience|job/i },
  { key: "end_year", aliases: [/^(employment |job )?end( date)? year$/i], sectionScope: /employ|work experience|job/i },
  { key: "is_current_job", aliases: [/currently work(ing)? here/i, /current (job|position|role)/i], sectionScope: /employ|work experience|job/i },
  { key: "institution_name", aliases: [/^(institution|institution name|school|school name|university|college)$/i], sectionScope: /educ|school/i },
  { key: "degree_level", aliases: [/^degree level$/i, /^level of education$/i], sectionScope: /educ|school/i },
  { key: "degree_name", aliases: [/^(degree|degree name)$/i], sectionScope: /educ|school/i },
  { key: "field_of_study", aliases: [/^(field of study|major|discipline)$/i], sectionScope: /educ|school/i },
  { key: "study_start_month", aliases: [/^(education |school )?start( date)? month$/i], sectionScope: /educ|school/i },
  { key: "study_start_year", aliases: [/^(education |school )?start( date)? year$/i], sectionScope: /educ|school/i },
  { key: "study_end_month", aliases: [/^(education |school )?end( date)? month$/i], sectionScope: /educ|school/i },
  { key: "study_end_year", aliases: [/^(education |school )?end( date)? year$/i], sectionScope: /educ|school/i },
  { key: "education_current", aliases: [/currently (attend|studying)/i, /current education/i], sectionScope: /educ|school/i },
  { key: "gpa", aliases: [/^(gpa|grade point average)$/i] },
  { key: "gender", aliases: [/^gender$/i] },
  { key: "race", aliases: [/^race$/i, /^race.*ethnicity$/i] },
  { key: "ethnicity_hispanic_latino", aliases: [/hispanic|latino/i] },
  { key: "veteran_status", aliases: [/veteran status/i, /^veteran$/i] },
  { key: "disability_status", aliases: [/disability status/i, /self-identif.*disability/i] },
];

export function normalizeFieldText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[*:()?]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
