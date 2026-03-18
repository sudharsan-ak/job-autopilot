function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function splitBodyParagraphs(value: string) {
  const parts = value
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return {
    mainParagraph: parts[0] ?? "",
    closingParagraph: parts.slice(1).join("\n\n")
  };
}

export function buildSubject(roleTitle: string) {
  return `Application for ${roleTitle} - Quick Intro`;
}

function buildGreeting(greetingName?: string) {
  return greetingName ? `Hi ${greetingName},` : "Hi [Name],";
}

export function inferGreetingNameFromEmail(email?: string) {
  if (!email) {
    return null;
  }

  const localPart = email.split("@")[0]?.trim().toLowerCase();
  if (!localPart) {
    return null;
  }

  const firstToken = localPart
    .split(/[._-]+/)
    .map((part) => part.replace(/\d+/g, "").trim())
    .find((part) => /^[a-z]{2,}$/.test(part));

  if (!firstToken) {
    return null;
  }

  return firstToken.charAt(0).toUpperCase() + firstToken.slice(1);
}

export function buildEmailBody(roleTitle: string, middleParagraph: string, greetingName?: string | null) {
  const escapedRoleTitle = escapeHtml(roleTitle);
  const { mainParagraph, closingParagraph } = splitBodyParagraphs(middleParagraph);
  const escapedMain = escapeHtml(mainParagraph);
  const escapedClosing = escapeHtml(closingParagraph);
  const greeting = buildGreeting(greetingName ?? undefined);
  const escapedGreeting = escapeHtml(greeting);

  const bodyText = [
    greeting,
    "",
    "Hope you're doing well.",
    "",
    `I'm Sudharsan Srinivasan, a Full Stack Software Engineer with 5+ years of experience working with JavaScript/TypeScript, React, Node.js, and databases (MongoDB + PostgreSQL/Supabase). I recently applied for the ${roleTitle} role and wanted to reach out directly.`,
    "",
    mainParagraph,
    ...(closingParagraph ? ["", closingParagraph] : []),
    "",
    "Best regards,",
    "Sudharsan S",
    "",
    "LinkedIn: https://www.linkedin.com/in/sudharsan-srinivasan10/",
    "Portfolio: https://sudharsansrinivasan.com/",
    "GitHub: https://github.com/sudharsan-ak"
  ].join("\n");

  const bodyHtml = [
    "<div>",
    `<p>${escapedGreeting}</p>`,
    "<p>Hope you're doing well.</p>",
    `<p>I'm <strong>Sudharsan Srinivasan</strong>, a Full Stack Software Engineer with <strong>5+ years</strong> of experience working with <strong>JavaScript/TypeScript, React, Node.js, and databases (MongoDB + PostgreSQL/Supabase)</strong>. I recently applied for the <strong>${escapedRoleTitle}</strong> role and wanted to reach out directly.</p>`,
    `<p>${escapedMain}</p>`,
    ...(closingParagraph ? [`<p>${escapedClosing}</p>`] : []),
    "<p>Best regards,<br><strong>Sudharsan S</strong></p>",
    `<p>LinkedIn: <a href="https://www.linkedin.com/in/sudharsan-srinivasan10/">https://www.linkedin.com/in/sudharsan-srinivasan10/</a><br>Portfolio: <a href="https://sudharsansrinivasan.com/">https://sudharsansrinivasan.com/</a><br>GitHub: <a href="https://github.com/sudharsan-ak">https://github.com/sudharsan-ak</a></p>`,
    "</div>"
  ].join("");

  return { bodyText, bodyHtml };
}
