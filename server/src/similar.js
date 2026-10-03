// "Postings like this one": TF-IDF cosine similarity over every saved
// posting.txt, counting only stack / role / industry terms — no model call,
// nothing leaves the server. Rebuilt per request: ~70 short texts take a
// few milliseconds.
import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";

// Only the words that say what the job IS — stack, kind of role, industry.
// Over all words, two postings looked alike for sharing an employer's
// boilerplate ("diversity", "coast to coast") rather than a stack.
// Phrases are joined into one term first ("power bi" -> "power-bi"); words
// that are also plain English (go, rest, lead, excel, express) are left out.
const PHRASES = [
  "asp.net core", "asp.net mvc", ".net core", ".net framework", "entity framework", "web api", "power bi",
  "power apps", "power automate", "power platform", "azure devops", "azure functions", "service bus",
  "app service", "sql server", "t-sql", "stored procedures", "full stack", "full-stack", "front end",
  "front-end", "back end", "back-end", "help desk", "service desk", "desktop support", "technical support",
  "data engineer", "data warehouse", "machine learning", "unit testing", "github actions", "active directory",
  "react native", "rest api", "restful api", "ci/cd", "infrastructure as code", "node.js", "vue.js",
  "next.js", "spring boot", "google cloud", "microsoft 365", "office 365", "dynamics 365",
];
const VOCAB = new Set(`c# .net asp.net-core asp.net-mvc asp.net .net-core .net-framework entity-framework web-api
linq wcf soap restful-api rest-api graphql grpc microservices winforms wpf blazor razor mvc
javascript typescript react angular vue vue.js next.js node.js jquery html css bootstrap tailwind
python java spring-boot golang php ruby kotlin react-native flutter
sql t-sql sql-server stored-procedures oracle postgresql postgres mysql mongodb nosql cosmos redis
elasticsearch ssis ssrs ssas etl data-warehouse databricks snowflake kafka rabbitmq service-bus
power-bi power-apps power-automate power-platform dynamics-365 sharepoint
azure aws gcp google-cloud azure-devops azure-functions app-service bicep terraform
infrastructure-as-code docker kubernetes openshift helm ci/cd github-actions jenkins devops git
unit-testing xunit nunit selenium cypress playwright jest testing qa tdd
oauth jwt saml sso active-directory entra security owasp
linux windows powershell bash networking vmware intune microsoft-365 office-365
help-desk service-desk desktop-support technical-support troubleshooting ticketing itil
full-stack front-end back-end frontend backend data-engineer dba analyst architect senior junior
machine-learning ai llm
healthcare hospital clinical ehr emr hl7 fhir banking bank finance financial fintech payments insurance
government public-sector retail e-commerce manufacturing logistics telecom nonprofit`.split(/\s+/));

export function tokenize(text) {
  let t = String(text).toLowerCase();
  for (const p of PHRASES) t = t.split(p).join(" " + p.replace(/\s+/g, "-") + " ");
  return (t.match(/[a-z0-9#.+\-/]+/g) || [])
    .map((w) => w.replace(/^[\-/]+|[.\-/,]+$/g, ""))
    .filter((w) => VOCAB.has(w));
}

function termCounts(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

// docs: [{ folder, text }] -> unit TF-IDF vectors (Map term -> weight)
export function vectorize(docs) {
  const counts = docs.map((d) => termCounts(tokenize(d.text)));
  const df = new Map();
  for (const c of counts) for (const t of c.keys()) df.set(t, (df.get(t) || 0) + 1);
  const n = docs.length;
  return counts.map((c) => {
    const v = new Map();
    let norm = 0;
    for (const [t, tf] of c) {
      // A term found in a single posting can't make two postings alike.
      const d = df.get(t);
      if (d < 2 && n > 2) continue;
      // Smoothed IDF: a term every posting shares still counts a little,
      // so two postings out of two can be compared at all.
      const w = (1 + Math.log(tf)) * Math.log(1 + n / d);
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });
}

function cosine(a, b) {
  let s = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, w] of small) {
    const o = big.get(t);
    if (o) s += w * o;
  }
  return s;
}

function sharedTerms(a, b, k) {
  return [...a.keys()]
    .filter((t) => b.has(t))
    .sort((x, y) => a.get(y) * b.get(y) - a.get(x) * b.get(x))
    .slice(0, k);
}

export function readPostings(applicationsDir) {
  if (!existsSync(applicationsDir)) return [];
  return readdirSync(applicationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const p = path.join(applicationsDir, d.name, "posting.txt");
      return existsSync(p) ? [{ folder: d.name, text: readFileSync(p, "utf-8") }] : [];
    });
}

// The postings most like `folder`'s, best first.
export function similarTo(folder, docs, { limit = 5, min = 0.2 } = {}) {
  const i = docs.findIndex((d) => d.folder === folder);
  if (i < 0) return [];
  const vecs = vectorize(docs);
  return docs
    .map((d, j) => ({ folder: d.folder, similarity: j === i ? -1 : cosine(vecs[i], vecs[j]), j }))
    .filter((r) => r.similarity >= min)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
    .map(({ folder: f, similarity, j }) => ({
      folder: f,
      similarity: Math.round(similarity * 100) / 100,
      shared: sharedTerms(vecs[i], vecs[j], 6),
    }));
}
