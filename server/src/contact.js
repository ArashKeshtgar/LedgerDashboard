// The hiring contact for an application: who to follow up with by email.
//
// The rule that matters: only an address that was PUBLISHED to you or that
// you VERIFIED gets stored. A guessed one (careers@, firstname@...) usually
// bounces or goes unread, which is worse than not emailing at all — so the
// server refuses it rather than trusting the form to.
export const CONTACT_FIELDS = ["contact_name", "contact_email", "contact_source", "contact_verified"];

// Where the address came from. The first three are published by definition
// (the posting showed it, the ATS confirmation came from it, the person
// wrote to you); "found" means you looked it up yourself and must have
// checked it before it can be saved.
export const CONTACT_SOURCES = {
  posting: { label: "Listed in the posting", published: true },
  ats_email: { label: "Reply-to of the ATS confirmation", published: true },
  recruiter_reply: { label: "They emailed me", published: true },
  found: { label: "Found it myself (company site, hiring team)", published: false },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export class ContactValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContactValidationError";
  }
}

const isTrue = (v) => v === true || v === "true" || v === 1 || v === "1";

// Merges contact updates into the row's current contact and returns the
// four fields to store, or throws ContactValidationError. Stored shape is
// the API's: strings, with contact_verified "true" or "".
export function resolveContact(current, updates) {
  const merged = { ...pick(current), ...pick(updates) };
  const name = String(merged.contact_name ?? "").trim();
  const email = String(merged.contact_email ?? "").trim().toLowerCase();
  const source = String(merged.contact_source ?? "").trim();

  // No email: nothing to vouch for, so source/verified are cleared.
  if (!email) return { contact_name: name, contact_email: "", contact_source: "", contact_verified: "" };

  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw new ContactValidationError(`"${email}" is not a valid email address.`);
  }
  if (!CONTACT_SOURCES[source]) {
    throw new ContactValidationError(
      `Say where the email came from (${Object.keys(CONTACT_SOURCES).join(", ")}).`
    );
  }
  const verified = CONTACT_SOURCES[source].published || isTrue(merged.contact_verified);
  if (!verified) {
    throw new ContactValidationError(
      "Only published or verified addresses are saved. Check this one exists first — a guessed address usually bounces."
    );
  }
  return { contact_name: name, contact_email: email, contact_source: source, contact_verified: "true" };
}

function pick(obj) {
  const out = {};
  for (const f of CONTACT_FIELDS) if (obj && obj[f] !== undefined) out[f] = obj[f];
  return out;
}
