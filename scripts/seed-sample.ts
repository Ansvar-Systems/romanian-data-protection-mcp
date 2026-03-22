/**
 * Seed the ANSPDCP database with sample decisions and guidelines for testing.
 *
 * Includes real ANSPDCP decisions (UniCredit Bank, World Trade Center, Raiffeisen Bank)
 * and representative guidance documents so MCP tools can be tested without
 * running a full data ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["ANSPDCP_DB_PATH"] ?? "data/anspdcp.db";
const force = process.argv.includes("--force");

// --- Bootstrap database ------------------------------------------------------

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// --- Topics ------------------------------------------------------------------

interface TopicRow {
  id: string;
  name_ro: string;
  name_en: string;
  description: string;
}

const topics: TopicRow[] = [
  {
    id: "consent",
    name_ro: "Consimțământ",
    name_en: "Consent",
    description: "Colectarea, validitatea și retragerea consimțământului pentru prelucrarea datelor cu caracter personal (art. 7 GDPR).",
  },
  {
    id: "cookies",
    name_ro: "Cookie-uri și instrumente de urmărire",
    name_en: "Cookies and trackers",
    description: "Plasarea și citirea cookie-urilor și a instrumentelor de urmărire pe dispozitivele utilizatorilor.",
  },
  {
    id: "transfers",
    name_ro: "Transferuri internaționale",
    name_en: "International transfers",
    description: "Transferuri de date cu caracter personal către țări terțe sau organizații internaționale (art. 44–49 GDPR).",
  },
  {
    id: "dpia",
    name_ro: "Evaluarea impactului asupra protecției datelor (DPIA)",
    name_en: "Data Protection Impact Assessment (DPIA)",
    description: "Evaluarea riscurilor pentru drepturile și libertățile persoanelor în cazul prelucrărilor cu risc ridicat (art. 35 GDPR).",
  },
  {
    id: "breach_notification",
    name_ro: "Încălcarea securității datelor",
    name_en: "Data breach notification",
    description: "Notificarea încălcărilor securității datelor către ANSPDCP și persoanele vizate (art. 33–34 GDPR).",
  },
  {
    id: "privacy_by_design",
    name_ro: "Protecția datelor prin proiectare",
    name_en: "Privacy by design",
    description: "Integrarea protecției datelor prin proiectare și implicit (art. 25 GDPR).",
  },
  {
    id: "cctv",
    name_ro: "Videomonitorizare",
    name_en: "CCTV and video surveillance",
    description: "Sisteme de supraveghere video în spații publice și private, inclusiv conformitatea cu GDPR.",
  },
  {
    id: "health_data",
    name_ro: "Date privind sănătatea",
    name_en: "Health data",
    description: "Prelucrarea datelor privind sănătatea — categorii speciale care necesită garanții sporite (art. 9 GDPR).",
  },
  {
    id: "children",
    name_ro: "Date ale minorilor",
    name_en: "Children's data",
    description: "Protecția datelor cu caracter personal ale minorilor, în special în serviciile online (art. 8 GDPR).",
  },
];

const insertTopic = db.prepare(
  "INSERT OR IGNORE INTO topics (id, name_ro, name_en, description) VALUES (?, ?, ?, ?)",
);

for (const t of topics) {
  insertTopic.run(t.id, t.name_ro, t.name_en, t.description);
}

console.log(`Inserted ${topics.length} topics`);

// --- Decisions ---------------------------------------------------------------

interface DecisionRow {
  reference: string;
  title: string;
  date: string;
  type: string;
  entity_name: string;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  // ANSPDCP — UniCredit Bank Romania — EUR 130,000
  {
    reference: "ANSPDCP-2019-001",
    title: "Decizie ANSPDCP — UniCredit Bank S.A. (securitatea datelor clienților)",
    date: "2019-03-28",
    type: "sanction",
    entity_name: "UniCredit Bank S.A.",
    fine_amount: 130_000,
    summary:
      "ANSPDCP a aplicat UniCredit Bank o amendă de 130.000 EUR pentru încălcarea securității datelor a circa 337.000 de clienți, cauzată de vulnerabilități în sistemele informatice ale băncii care au permis accesul neautorizat la date personale.",
    full_text:
      "Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal (ANSPDCP) a efectuat o investigație la UniCredit Bank S.A. după ce banca a notificat o încălcare a securității datelor care a afectat aproximativ 337.042 de clienți. ANSPDCP a constatat că vulnerabilitățile din sistemele informatice ale băncii au permis accesul neautorizat la date personale ale clienților, inclusiv: nume și prenume, coduri numerice personale (CNP), date de contact, informații despre conturi bancare. Constatările ANSPDCP: (1) Măsuri tehnice insuficiente — banca nu a implementat măsuri tehnice și organizatorice adecvate pentru a asigura securitatea datelor cu caracter personal, conform art. 32 GDPR; sistemele informatice conțineau vulnerabilități cunoscute care nu fuseseră remediate în timp util; (2) Lipsa unei evaluări periodice a securității — banca nu efectuase testări de penetrare și audituri de securitate regulate pentru sistemele care prelucrau date ale clienților; (3) Notificarea tardivă — deși banca a notificat ANSPDCP, unele aspecte ale notificării nu au fost transmise în termenul de 72 de ore. ANSPDCP a aplicat amenda maximă calculată proporțional cu cifra de afaceri a băncii și a dispus măsuri corective pentru remedierea vulnerabilităților identificate.",
    topics: JSON.stringify(["breach_notification", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["32", "33", "34"]),
    status: "final",
  },
  // ANSPDCP — World Trade Center Bucharest — CCTV
  {
    reference: "ANSPDCP-2021-015",
    title: "Decizie ANSPDCP — World Trade Center Bucharest S.A. (videomonitorizare)",
    date: "2021-07-14",
    type: "sanction",
    entity_name: "World Trade Center Bucharest S.A.",
    fine_amount: 5_000,
    summary:
      "ANSPDCP a sancționat World Trade Center Bucharest cu o amendă de 5.000 EUR pentru operarea unui sistem de videomonitorizare fără informarea corespunzătoare a persoanelor vizate și fără efectuarea unei evaluări de impact (DPIA).",
    full_text:
      "ANSPDCP a efectuat o investigație la World Trade Center Bucharest S.A. privind sistemul de supraveghere video implementat în complexul de birouri. ANSPDCP a constatat: (1) Lipsa informării corespunzătoare — persoanele care intrau în spațiile monitorizate nu erau informate în mod adecvat despre sistemul de videomonitorizare; indicatoarele de avertizare lipseau sau erau insuficiente și nu conțineau toate informațiile obligatorii prevăzute de art. 13 GDPR (identitatea operatorului, scopul prelucrării, durata de stocare, drepturile persoanelor vizate); (2) Absența evaluării impactului — prelucrarea datelor prin sistemul de videomonitorizare a unui complex de birouri de mari dimensiuni cu trafic intens de persoane constituia o prelucrare care necesita efectuarea unei DPIA conform art. 35 GDPR; DPIA nu fusese realizată; (3) Durate de stocare neclare — entitatea nu documentase clar perioadele de stocare a înregistrărilor video și criteriile pentru prelungirea acestora. ANSPDCP a aplicat amenda și a dispus remedierea deficiențelor constatate.",
    topics: JSON.stringify(["cctv", "dpia", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["13", "25", "35"]),
    status: "final",
  },
  // ANSPDCP — Raiffeisen Bank — marketing without consent
  {
    reference: "ANSPDCP-2020-008",
    title: "Decizie ANSPDCP — Raiffeisen Bank S.A. (marketing fără consimțământ)",
    date: "2020-09-22",
    type: "sanction",
    entity_name: "Raiffeisen Bank S.A.",
    fine_amount: 20_000,
    summary:
      "ANSPDCP a aplicat Raiffeisen Bank o amendă de 20.000 EUR pentru transmiterea de comunicări comerciale clienților care nu și-au dat consimțământul pentru marketing și pentru nerespectarea solicitărilor de revocare a consimțământului.",
    full_text:
      "ANSPDCP a investigat Raiffeisen Bank S.A. în urma plângerilor primite de la clienți care au primit comunicări comerciale nesolicitate. Investigația a revelat: (1) Prelucrare pentru marketing direct fără consimțământ valid — banca a transmis oferte comerciale și mesaje promoționale unor clienți care nu își dăduseră consimțământul în conformitate cu cerințele art. 7 GDPR (consimțământ liber, specific, informat și neechivoc); consimțămintele fuseseră obținute anterior prin formulare cu casete pre-bifate sau prin bundling cu acceptarea termenilor contractuali; (2) Nerespectarea revocării consimțământului — clienții care au solicitat retragerea consimțământului pentru primirea comunicărilor comerciale au continuat să primească astfel de comunicări; banca nu dispunea de mecanisme tehnice eficace care să blocheze imediat transmiterea comunicărilor după retragerea consimțământului; (3) Absența mecanismelor de audit — banca nu putea demonstra că pentru fiecare persoană vizată din lista de marketing exista un consimțământ valid și documentat. ANSPDCP a aplicat amenda și a impus băncii implementarea unor sisteme robuste de gestionare a consimțămintelor.",
    topics: JSON.stringify(["consent"]),
    gdpr_articles: JSON.stringify(["6", "7", "21"]),
    status: "final",
  },
  // ANSPDCP — Telekom Romania — data breach
  {
    reference: "ANSPDCP-2022-003",
    title: "Decizie ANSPDCP — Telekom Romania Communications S.A. (încălcarea securității datelor)",
    date: "2022-04-11",
    type: "sanction",
    entity_name: "Telekom Romania Communications S.A.",
    fine_amount: 75_000,
    summary:
      "ANSPDCP a sancționat Telekom Romania cu o amendă de 75.000 EUR pentru o încălcare a securității datelor care a expus date personale ale clienților și pentru notificarea tardivă a autorității.",
    full_text:
      "ANSPDCP a investigat Telekom Romania Communications S.A. în urma unei notificări de incident de securitate. Incidentul a vizat date personale ale unui număr semnificativ de clienți, inclusiv date de identificare, date de contact și date de trafic (informații despre convorbirile efectuate). ANSPDCP a constatat: (1) Vulnerabilități tehnice neadresate — sistemele informatice ale Telekom Romania conțineau vulnerabilități de securitate care fuseseră identificate anterior dar nu remediate în timp util; (2) Notificare tardivă — Telekom Romania a notificat ANSPDCP cu depășirea termenului de 72 de ore prevăzut de art. 33 GDPR; (3) Notificare incompletă — notificarea transmisă ANSPDCP nu conținea toate informațiile obligatorii; (4) Nerespectarea dreptului la informare — persoanele vizate nu au fost notificate cu privire la riscul la care au fost expuse, deși riscul era ridicat datorită categoriei de date expuse. ANSPDCP a aplicat amenda și a dispus implementarea unui plan de remediere a vulnerabilităților de securitate.",
    topics: JSON.stringify(["breach_notification", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["32", "33", "34"]),
    status: "final",
  },
  // ANSPDCP — Enel Energie Muntenia — direct marketing
  {
    reference: "ANSPDCP-2021-022",
    title: "Decizie ANSPDCP — Enel Energie Muntenia S.A. (comunicări comerciale neautorizate)",
    date: "2021-11-30",
    type: "sanction",
    entity_name: "Enel Energie Muntenia S.A.",
    fine_amount: 8_000,
    summary:
      "ANSPDCP a aplicat Enel Energie Muntenia o amendă de 8.000 EUR pentru transmiterea de mesaje comerciale prin SMS și e-mail fără consimțământul prealabil al destinatarilor.",
    full_text:
      "ANSPDCP a investigat Enel Energie Muntenia S.A. în urma plângerilor primite de la consumatori care au primit mesaje comerciale prin SMS și e-mail referitoare la produse și servicii ale companiei, fără a-și fi dat consimțământul în prealabil. ANSPDCP a constatat că: (1) Baza juridică pentru marketing direct — Enel s-a prevalat de interesul legitim conform art. 6(1)(f) GDPR ca bază juridică pentru transmiterea comunicărilor comerciale; ANSPDCP a concluzionat că, în absența unui test de echilibrare documentat care să demonstreze că interesele companiei prevalează față de drepturile persoanelor vizate, această bază juridică nu era aplicabilă pentru marketing direct nesolicitat; (2) Lipsa mecanismelor de opt-out — mesajele comerciale nu conțineau informații clare și accesibile privind modalitățile de retragere a consimțământului sau de exercitare a dreptului de opoziție; (3) Nerespectarea dreptului de opoziție — unii destinatari care au solicitat încetarea comunicărilor au continuat să primească astfel de mesaje.",
    topics: JSON.stringify(["consent"]),
    gdpr_articles: JSON.stringify(["6", "21"]),
    status: "final",
  },
  // ANSPDCP — Hospital — health data disclosure
  {
    reference: "ANSPDCP-2022-019",
    title: "Decizie ANSPDCP — Spital privat (divulgarea datelor medicale ale pacienților)",
    date: "2022-09-05",
    type: "sanction",
    entity_name: "Spital privat (anonimizat)",
    fine_amount: 10_000,
    summary:
      "ANSPDCP a sancționat un spital privat cu o amendă de 10.000 EUR pentru divulgarea datelor medicale ale pacienților unor terți neautorizați și pentru absența controalelor de acces adecvate la dosarele medicale.",
    full_text:
      "ANSPDCP a investigat un spital privat în urma plângerilor unor pacienți ale căror date medicale (diagnostice, tratamente, rezultate ale analizelor) fuseseră accesate sau divulgate unor persoane neautorizate. ANSPDCP a constatat: (1) Acces neautorizat la dosarele medicale — sistemul informatic al spitalului nu implementa controale de acces bazate pe roluri; mai mulți angajați aveau acces la dosarele medicale ale pacienților pe care nu îi tratau direct; (2) Divulgarea datelor medicale fără consimțământ — date privind sănătatea pacienților (categorii speciale de date conform art. 9 GDPR) fuseseră transmise unor terți fără consimțământul expres al pacienților și fără o bază juridică adecvată conform art. 9(2) GDPR; (3) Absența DPIA — prelucrarea în scop medical a datelor privind sănătatea la scară largă necesita efectuarea unei evaluări de impact, care nu fusese realizată; (4) Securitate insuficientă — dosarele medicale nu erau protejate prin mecanisme de criptare adecvate.",
    topics: JSON.stringify(["health_data", "privacy_by_design", "dpia"]),
    gdpr_articles: JSON.stringify(["9", "25", "32", "35"]),
    status: "final",
  },
  // ANSPDCP — Real estate — excessive data collection
  {
    reference: "ANSPDCP-2020-034",
    title: "Decizie ANSPDCP — Agenție imobiliară (colectare excesivă de date)",
    date: "2020-12-17",
    type: "warning",
    entity_name: "Agenție imobiliară (anonimizat)",
    fine_amount: null,
    summary:
      "ANSPDCP a emis un avertisment unei agenții imobiliare care colecta copii ale actelor de identitate ale clienților interesați de proprietăți, fără bază juridică adecvată și fără a respecta principiul minimizării datelor.",
    full_text:
      "ANSPDCP a investigat o agenție imobiliară care solicita persoanelor interesate de vizitarea proprietăților să prezinte și să lase copii ale actelor de identitate. ANSPDCP a constatat: (1) Absența bazei juridice — copierea și stocarea actelor de identitate ale potențialilor cumpărători/chiriași nu era justificată printr-o bază juridică validă conform art. 6 GDPR; verificarea identității se poate realiza prin vizualizarea actului fără a face copii; (2) Principiul minimizării datelor — colectarea de copii ale actelor de identitate în etapa de vizionare a proprietăților (înainte de orice relație contractuală) viola principiul minimizării datelor prevăzut de art. 5(1)(c) GDPR; (3) Absența informării — clienții nu primeau informații adecvate despre prelucrarea datelor lor conform art. 13 GDPR; (4) Stocare inadecvată — copiile actelor de identitate erau stocate fără un termen de ștergere definit și fără măsuri adecvate de securitate. ANSPDCP a emis avertismentul și a recomandat renunțarea la practica copierii actelor de identitate.",
    topics: JSON.stringify(["privacy_by_design", "consent"]),
    gdpr_articles: JSON.stringify(["5", "6", "13"]),
    status: "final",
  },
  // ANSPDCP — Retailer — loyalty program
  {
    reference: "ANSPDCP-2023-007",
    title: "Decizie ANSPDCP — Lanț de retail (program de fidelizare fără consimțământ)",
    date: "2023-05-16",
    type: "sanction",
    entity_name: "Lanț de retail (anonimizat)",
    fine_amount: 15_000,
    summary:
      "ANSPDCP a sancționat un lanț de retail cu o amendă de 15.000 EUR pentru înscrierea automată a clienților în programe de marketing fără consimțământ și pentru profilarea clienților pe baza comportamentului de cumpărare fără informare adecvată.",
    full_text:
      "ANSPDCP a investigat un lanț de retail în urma plângerilor clienților privind utilizarea datelor din programul de fidelizare. ANSPDCP a constatat: (1) Înscrierea automată la marketing — la înscrierea în programul de fidelizare, clienții erau automat înscriși pentru primirea comunicărilor comerciale, fără a se bifa explicit o căsuță de consimțământ; (2) Profilarea clienților fără informare adecvată — lanțul de retail utiliza datele din programul de fidelizare pentru a crea profiluri detaliate ale clienților (preferințe de cumpărare, frecvența vizitelor, categorii de produse achiziționate) și pentru a trimite oferte personalizate; clienții nu fuseseră informați despre natura și amploarea profilării; (3) Imposibilitatea de a utiliza programul fără consimțământ pentru marketing — programul de fidelizare era conceput astfel încât utilizarea beneficiilor (reduceri, puncte) era practic condiționată de acceptarea comunicărilor comerciale; (4) Transferuri către terți — datele profilate erau partajate cu parteneri comerciali fără consimțământul explicit al clienților.",
    topics: JSON.stringify(["consent", "transfers", "privacy_by_design"]),
    gdpr_articles: JSON.stringify(["5", "6", "7", "13", "22"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(
      d.reference,
      d.title,
      d.date,
      d.type,
      d.entity_name,
      d.fine_amount,
      d.summary,
      d.full_text,
      d.topics,
      d.gdpr_articles,
      d.status,
    );
  }
});

insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

// --- Guidelines --------------------------------------------------------------

interface GuidelineRow {
  reference: string | null;
  title: string;
  date: string;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
}

const guidelines: GuidelineRow[] = [
  {
    reference: "ANSPDCP-GUIDE-DPIA-2021",
    title: "Ghid privind evaluarea impactului asupra protecției datelor cu caracter personal (DPIA)",
    date: "2021-05-25",
    type: "guideline",
    summary:
      "Ghidul ANSPDCP privind efectuarea evaluărilor de impact (DPIA) conform art. 35 GDPR. Cuprinde lista prelucrărilor pentru care DPIA este obligatorie, metodologia în trei etape și cerințele de documentare.",
    full_text:
      "Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal a publicat un ghid practic privind evaluarea impactului asupra protecției datelor cu caracter personal (DPIA) în conformitate cu art. 35 din Regulamentul (UE) 2016/679 (GDPR). Când este obligatorie DPIA: O DPIA este obligatorie atunci când prelucrarea este susceptibilă să genereze un risc ridicat pentru drepturile și libertățile persoanelor fizice. Conform ghidului, prelucrările care necesită obligatoriu DPIA includ: evaluarea sistematică și exhaustivă a aspectelor personale privind persoane fizice prin profilare automatizată; prelucrarea pe scară largă a categoriilor speciale de date; monitorizarea sistematică a spațiilor publice la scară largă. ANSPDCP a publicat lista specifică a tipurilor de prelucrări care necesită efectuarea unei DPIA. Metodologia DPIA cuprinde trei etape: (1) Descrierea operațiunilor de prelucrare și a scopurilor acestora — categoriile de date prelucrate, destinatarii datelor, transferurile internaționale, termenele de stocare; (2) Evaluarea necesității și proporționalității prelucrării — temei juridic, minimizarea datelor, exactitatea datelor, drepturile persoanelor vizate; (3) Gestionarea riscurilor la adresa drepturilor și libertăților persoanelor vizate — identificarea amenințărilor (acces neautorizat, modificare neintenționată, indisponibilitate), evaluarea probabilității și gravității, identificarea măsurilor de atenuare. Dacă riscul rezidual rămâne ridicat în ciuda măsurilor, operatorul este obligat să consulte în prealabil ANSPDCP.",
    topics: JSON.stringify(["dpia", "privacy_by_design"]),
    language: "ro",
  },
  {
    reference: "ANSPDCP-GUIDE-COOKIES-2021",
    title: "Ghid privind utilizarea cookie-urilor și a altor instrumente similare de urmărire",
    date: "2021-09-10",
    type: "guideline",
    summary:
      "Ghidul ANSPDCP privind utilizarea cookie-urilor și a instrumentelor similare de urmărire pe site-urile web și în aplicațiile mobile. Cuprinde cerințele de consimțământ, excepțiile pentru cookie-urile strict necesare și cerințele pentru bannerele de cookie.",
    full_text:
      "Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal a emis ghiduri referitoare la utilizarea cookie-urilor și a altor instrumente de urmărire în contextul GDPR și al Directivei privind confidențialitatea și comunicațiile electronice. Cerințe de consimțământ: Înainte de a plasa cookie-uri non-esențiale pe dispozitivul utilizatorului, operatorul trebuie să obțină consimțământul valid al acestuia. Consimțământul trebuie să fie: liber (fără constrângere), specific (pentru fiecare categorie de cookie în parte), informat (utilizatorul trebuie să înțeleagă la ce consimte) și exprimat printr-o acțiune afirmativă neechivocă. Cerințe pentru bannerele de cookie: Bannerul trebuie să ofere opțiuni de acceptare și refuz la fel de ușor accesibile; butoanele „Acceptă tot\" și „Refuză tot\" trebuie să fie prezente și egale ca vizibilitate; nu sunt permise casete pre-bifate sau setări prestabilite care presupun consimțământul; nu sunt permise schemele de design înșelătoare (dark patterns) care fac refuzul mai dificil. Cookie-uri exceptate de la cerința consimțământului: cookie-uri de sesiune, cookie-uri de coș de cumpărături, cookie-uri de autentificare, cookie-uri de securitate. ANSPDCP avertizează împotriva „cookie wall\" — condiționarea accesului la un serviciu de acceptarea cookie-urilor non-esențiale.",
    topics: JSON.stringify(["cookies", "consent"]),
    language: "ro",
  },
  {
    reference: "ANSPDCP-GUIDE-VIDEOMONITORIZARE-2020",
    title: "Ghid privind videomonitorizarea conform GDPR",
    date: "2020-11-20",
    type: "guideline",
    summary:
      "Ghidul ANSPDCP privind operarea sistemelor de videomonitorizare în conformitate cu GDPR. Cuprinde temeiul juridic, obligațiile de informare, termenele de stocare a înregistrărilor și reguli speciale pentru spații de muncă, spații publice și spații comerciale.",
    full_text:
      "Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal a publicat ghiduri privind videomonitorizarea în contextul GDPR. Temeiul juridic: Persoanele juridice private pot opera sisteme de videomonitorizare pe baza interesului legitim (art. 6(1)(f) GDPR), cu condiția efectuării unui test de echilibrare care să demonstreze că scopul (securitate, protecția proprietății) este necesar și proporțional; autoritățile publice se bazează pe exercitarea autorității publice (art. 6(1)(e) GDPR). Obligații de informare: La intrarea în spațiile monitorizate trebuie plasate panouri de avertizare vizibile, conținând: identitatea operatorului, scopul prelucrării, durata stocării înregistrărilor, drepturile persoanelor vizate și datele de contact. Durate de stocare: Înregistrările video nu trebuie stocate mai mult de 30 de zile, cu excepția cazului în care un incident specific justifică stocarea extinsă. Locuri de muncă: Videomonitorizarea la locul de muncă trebuie să fie proporțională și angajații trebuie informați în prealabil; videomonitorizarea ascunsă este interzisă. Locații interzise: camere de schimb, toalete, vestiare, zone de alăptare. DPIA: Operarea unui sistem de videomonitorizare în spații publice sau la locul de muncă necesită efectuarea unei DPIA.",
    topics: JSON.stringify(["cctv", "dpia", "privacy_by_design"]),
    language: "ro",
  },
  {
    reference: "ANSPDCP-GUIDE-NOTIFICARE-2019",
    title: "Ghid privind notificarea încălcărilor de securitate a datelor cu caracter personal",
    date: "2019-10-07",
    type: "guideline",
    summary:
      "Ghidul ANSPDCP privind gestionarea și notificarea încălcărilor de securitate a datelor. Acoperă obligația de notificare în 72 de ore, informarea persoanelor vizate și documentarea incidentelor în registrul intern.",
    full_text:
      "Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal a emis îndrumări privind gestionarea încălcărilor de securitate a datelor cu caracter personal conform art. 33–34 GDPR. Ce este o încălcare a securității datelor: O încălcare de securitate este orice incident care conduce la distrugerea, pierderea, modificarea, divulgarea neautorizată sau accesul neautorizat la datele cu caracter personal, în mod accidental sau ilegal. Notificarea ANSPDCP (art. 33 GDPR): Operatorul trebuie să notifice ANSPDCP fără întârzieri nejustificate și, dacă este posibil, în cel mult 72 de ore de la data la care a luat cunoștință de încălcare; notificarea trebuie să cuprindă: natura încălcării, categoriile și numărul aproximativ de persoane vizate, consecințele probabile și măsurile luate; dacă notificarea completă nu poate fi transmisă în 72 de ore, se poate transmite în etape. Informarea persoanelor vizate (art. 34 GDPR): Când încălcarea este susceptibilă să genereze un risc ridicat, operatorul trebuie să informeze persoanele vizate fără întârzieri nejustificate; informarea nu este obligatorie dacă datele sunt criptate sau dacă ar necesita eforturi disproporționate. Registrul intern al încălcărilor: Toate încălcările, inclusiv cele care nu necesită notificarea ANSPDCP, trebuie documentate în registrul intern.",
    topics: JSON.stringify(["breach_notification"]),
    language: "ro",
  },
  {
    reference: "ANSPDCP-GUIDE-ANGAJATI-2022",
    title: "Ghid privind prelucrarea datelor cu caracter personal ale angajaților",
    date: "2022-03-15",
    type: "guideline",
    summary:
      "Ghidul ANSPDCP privind prelucrarea datelor angajaților la locul de muncă. Cuprinde recrutarea, relația de angajare, monitorizarea comunicațiilor, urmărirea locației și încetarea contractului de muncă.",
    full_text:
      "Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal a publicat un ghid privind prelucrarea datelor cu caracter personal ale angajaților în contextul GDPR și al legislației muncii din România. Temei juridic: Prelucrarea datelor angajaților se poate baza pe art. 6(1)(b) GDPR (executarea contractului de muncă), art. 6(1)(c) (obligație legală) sau art. 6(1)(f) (interesul legitim); consimțământul angajatului nu este, de regulă, un temei juridic adecvat din cauza dezechilibrului de putere din relația angajator-angajat. Recrutare: Datele colectate în procesul de recrutare trebuie să fie limitate la cele necesare evaluării competențelor; CV-urile candidaților respinși trebuie șterse după o perioadă rezonabilă. Monitorizarea comunicațiilor: Angajatorul poate monitoriza comunicațiile de serviciu numai dacă angajații au fost informați în prealabil și monitorizarea este proporțională cu scopul; interceptarea corespondenței private pe dispozitivele de serviciu este interzisă. Urmărirea locației: Urmărirea GPS a vehiculelor sau dispozitivelor de serviciu este permisă pentru scopuri legitime de management al flotei sau securitate, dar monitorizarea continuă în afara orelor de program este interzisă.",
    topics: JSON.stringify(["consent", "privacy_by_design", "cctv"]),
    language: "ro",
  },
];

const insertGuideline = db.prepare(`
  INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertGuidelinesAll = db.transaction(() => {
  for (const g of guidelines) {
    insertGuideline.run(
      g.reference,
      g.title,
      g.date,
      g.type,
      g.summary,
      g.full_text,
      g.topics,
      g.language,
    );
  }
});

insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);

// --- Summary -----------------------------------------------------------------

const decisionCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }
).cnt;
const guidelineCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }
).cnt;
const topicCount = (
  db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }
).cnt;
const decisionFtsCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions_fts").get() as { cnt: number }
).cnt;
const guidelineFtsCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Topics:         ${topicCount}`);
console.log(`  Decisions:      ${decisionCount} (FTS entries: ${decisionFtsCount})`);
console.log(`  Guidelines:     ${guidelineCount} (FTS entries: ${guidelineFtsCount})`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
