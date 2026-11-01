// netlify/doctum/facets.js — the fixed vocabularies used for demand analytics.
//
// Everything Doctum may count about an applicant is a value from one of these
// lists. Nothing free-form from a CV is ever kept: the CV is read in memory,
// mapped onto these coarse categories, and only the category names are logged
// (and only when the applicant ticks "count me in"). The same skill list is run
// over the adverts, so universities can compare what applicants bring with what
// adverts ask for.

// Undergraduate (first-degree) subject → Doctum's PhD subject areas.
// First match wins, so the more specific patterns come first.
const UG = [
  ['Computer Science & AI', /computer|computing|software|artificial intelligence|\bai\b|data science|informatics|cyber/],
  ['Mathematics & Statistics', /math|statistic|actuar/],
  ['Physics & Astronomy', /physics|astro|astronomy/],
  ['Chemistry', /chemistry|chemical sciences/],
  ['Materials Science', /materials|metallurg|polymer/],
  ['Engineering', /engineer|mechatronic|aerospace|aeronautic|naval|robotics|electronic|electrical|civil|mechanical|automotive|motorsport/],
  ['Environment & Earth Sciences', /geolog|geoscien|earth science|environment|ocean|marine science|meteorolog|climate|geography|ecology|conservation/],
  ['Medicine & Health', /medicine|\bmbbs\b|\bmbchb\b|nursing|pharmac|dentist|physiotherap|public health|biomedical|radiograph|midwif|optometr|veterinar|nutrition|sport science|exercise science/],
  ['Biological Sciences', /biolog|bioscien|biochem|genetic|microbiol|zoolog|neurosci|molecular|botany|plant science|biotech/],
  ['Psychology', /psycholog|cognitive science/],
  ['Business & Economics', /econom|business|management|finance|accounting|marketing/],
  ['Law', /\blaw\b|\bllb\b|legal|jurisprud/],
  ['Social Sciences', /sociolog|politic|international relations|anthropolog|social policy|criminolog|education|social work|development studies/],
  ['Arts & Humanities', /history|english|literature|philosoph|classics|music|art\b|fine art|design|languages|linguistic|theolog|religio|archaeolog|film|media|drama|theatre/],
];

const BACHELOR = /\b(b\.?\s?sc|b\.?\s?eng|b\.?\s?a\b|b\.?\s?tech|b\.?\s?e\b|llb|bmus|mbbs|mbchb|integrated master'?s|m\.?\s?eng|m\.?\s?phys|m\.?\s?chem|m\.?\s?sci|m\.?\s?math|bachelor'?s?|undergraduate degree)\b/i;

// The first-degree subject, from the first line in the CV that names a bachelor's
// (or an integrated master's such as MEng, which is a first degree in the UK).
export function firstDegreeSubject(text) {
  const lines = String(text || '').slice(0, 30000).split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!BACHELOR.test(lines[i])) continue;
    const s = (lines[i] + ' ' + (lines[i + 1] || '')).toLowerCase();
    const hit = UG.find(([, re]) => re.test(s));
    if (hit) return hit[0];
  }
  return '';
}

// Skill and method groups. Deliberately broad: "Python", not "pandas 2.1".
export const SKILLS = [
  ['Python', /\bpython\b/],
  // "R" alone is too ambiguous to match; only count it in a list of tools or by name.
  ['R', /\br programming\b|\brstudio\b|\btidyverse\b|\bggplot|(?:python|matlab|sql|stata|spss),? (?:and )?r\b(?![-'’])|\br,? (?:and )?(?:python|matlab|sql|stata|spss)\b/],
  ['MATLAB', /\bmatlab\b|\bsimulink\b/],
  ['C / C++', /\bc\+\+|\bc\/c\+\+|\bembedded c\b/],
  ['Machine learning', /machine learning|deep learning|neural network|pytorch|tensorflow|scikit|computer vision|natural language processing|\bnlp\b|reinforcement learning|large language model/],
  ['Statistics', /statistic|regression|bayesian|\bspss\b|\bstata\b|hypothesis test|mixed[- ]effects|survival analysis/],
  ['High-performance computing', /\bhpc\b|high[- ]performance comput|parallel comput|\bmpi\b|\bcuda\b|\bgpu\b/],
  ['Simulation and modelling', /simulation|numerical model|finite element|\bfea\b|\bfem\b|\bcfd\b|computational fluid|ansys|abaqus|comsol|openfoam|molecular dynamics|\bdft\b|monte carlo/],
  ['CAD and design', /\bcad\b|solidworks|autocad|catia|fusion 360|\bsiemens nx\b/],
  ['Experimental lab work', /laborator|\blab\b|experimental|wet lab|bench work|\bpcr\b|cell culture|western blot|assay|chromatograph|\bhplc\b|titration|synthesis/],
  ['Spectroscopy and imaging', /spectroscop|microscop|\bsem\b|\btem\b|\bxrd\b|\bnmr\b|mass spectrometr|\bmri\b|confocal|raman|\bftir\b/],
  ['Electronics and control', /electronics|circuit|\bpcb\b|signal processing|control system|\bplc\b|\bfpga\b|microcontroller|arduino|robot/],
  ['Fieldwork and GIS', /fieldwork|field work|field survey|\bgis\b|arcgis|qgis|remote sensing|sampling campaign/],
  ['Qualitative research', /qualitative|interview|focus group|ethnograph|thematic analysis|discourse analysis|grounded theory/],
  ['Survey and quantitative social research', /questionnaire|survey design|\bsurvey\b|econometric|panel data|quantitative method/],
  ['Clinical and patient research', /clinical|patient|\bnhs\b|trial|epidemiolog|cohort study/],
  ['Archival and textual research', /archiv|manuscript|primary sources|textual analysis|close reading/],
  ['Data engineering and databases', /\bsql\b|database|data pipeline|big data|spark|cloud computing|\baws\b|azure/],
];

export function skillsIn(text) {
  const s = ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  return SKILLS.filter(([, re]) => re.test(s)).map(([k]) => k);
}

// Research evidence on a CV, as yes/no flags only.
export function researchFlags(text) {
  const s = String(text || '').toLowerCase();
  return {
    pub: /\bpublications?\b|\bjournal of\b|\bproceedings\b|conference paper|\bdoi\b|peer[- ]reviewed|\bpublished in\b/.test(s),
    proj: /dissertation|thesis|research project|final[- ]year project|individual project|research assistant|\burop\b|summer research/.test(s),
    ind: /\binternship\b|\bintern\b|placement|year in industry|industrial experience|graduate engineer|\bworked as\b|employment/.test(s),
  };
}

// Countries offered for "where did you take your first degree?" (optional; the
// list keeps the answers to a fixed set). Anything else is "Other".
export const COUNTRIES = [
  ['GB', 'United Kingdom'], ['IE', 'Ireland'], ['IN', 'India'], ['CN', 'China'], ['PK', 'Pakistan'], ['NG', 'Nigeria'],
  ['GH', 'Ghana'], ['KE', 'Kenya'], ['EG', 'Egypt'], ['SA', 'Saudi Arabia'], ['AE', 'United Arab Emirates'], ['IR', 'Iran'],
  ['TR', 'Turkey'], ['BD', 'Bangladesh'], ['LK', 'Sri Lanka'], ['NP', 'Nepal'], ['MY', 'Malaysia'], ['SG', 'Singapore'],
  ['ID', 'Indonesia'], ['VN', 'Vietnam'], ['TH', 'Thailand'], ['HK', 'Hong Kong'], ['TW', 'Taiwan'], ['JP', 'Japan'],
  ['KR', 'South Korea'], ['US', 'United States'], ['CA', 'Canada'], ['MX', 'Mexico'], ['BR', 'Brazil'], ['CO', 'Colombia'],
  ['CL', 'Chile'], ['AU', 'Australia'], ['NZ', 'New Zealand'], ['ZA', 'South Africa'], ['DE', 'Germany'], ['FR', 'France'],
  ['IT', 'Italy'], ['ES', 'Spain'], ['PT', 'Portugal'], ['NL', 'Netherlands'], ['GR', 'Greece'], ['CY', 'Cyprus'],
  ['PL', 'Poland'], ['RO', 'Romania'], ['SE', 'Sweden'],
];
export const COUNTRY_CODES = new Set(COUNTRIES.map(([c]) => c).concat('OTHER'));
