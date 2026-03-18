import { Profile } from "../config";

type OutreachEmail = {
  subject: string;
  middleParagraph: string;
};

type GenerateOutreachEmailInput = {
  profile: Profile;
  jobTitle: string;
  companyName: string;
  jobUrl: string;
  requiredSkills: string[];
  preferredSkills: string[];
  coreResponsibilities: string[];
  seniority: string;
  domainKeywords: string[];
  fixedIntro: string;
  fixedClosing: string;
};

function requireOpenAiApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY in .env");
  }
  return apiKey;
}

export async function generateOutreachEmail(input: GenerateOutreachEmailInput): Promise<OutreachEmail> {
  const apiKey = requireOpenAiApiKey();
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-5.3-chat-latest",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You write concise recruiter outreach emails for job applications.",
            "Return valid JSON with keys subject and middleParagraph only.",
            "You are writing only the tailored middle paragraph for a recruiter outreach email.",
            "The intro and closing are assembled elsewhere."
          ].join(" ")
        },
        {
          role: "user",
          content: [
            `Role title: ${input.jobTitle}`,
            `Company: ${input.companyName}`,
            `Job URL: ${input.jobUrl}`,
            "",
            `Required skills: ${input.requiredSkills.join(", ") || "Not clearly listed"}`,
            `Preferred skills: ${input.preferredSkills.join(" | ") || "Not clearly listed"}`,
            `Core responsibilities: ${input.coreResponsibilities.join(" | ") || "Not clearly listed"}`,
            `Seniority / experience level: ${input.seniority || "Not clearly listed"}`,
            `Product / domain keywords: ${input.domainKeywords.join(", ") || "Not clearly listed"}`,
            "",
            "Requirements:",
            "- Subject must be exactly 'Application for <Role Title> - Quick Intro'.",
            "- Write only one tailored middle paragraph.",
            "- The middle paragraph should be specific to the role and reference relevant fit from the JD.",
            "- Do not invent experience that is not supported by the provided intro, profile, or job description.",
            "- Keep it crisp: 1-2 short sentences max.",
            "- Target roughly 25-45 words.",
            "- Avoid filler, generic praise, and repetition of the intro."
          ].join("\n")
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OpenAI response did not include message content.");
  }

  const parsed = JSON.parse(content) as Partial<OutreachEmail>;
  if (!parsed.subject || !parsed.middleParagraph) {
    throw new Error("OpenAI response JSON was missing subject or middleParagraph.");
  }

  return {
    subject: parsed.subject.trim(),
    middleParagraph: parsed.middleParagraph.trim()
  };
}
