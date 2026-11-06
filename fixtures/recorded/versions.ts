// Recorded replies of the builder model to improvement requests, for the browser runs and the flow shots: the
// agent they were made for, the maker's sentence, and the reply as the model returned it. Anything not recorded
// here gets the plain stand-in in server/ai/fake.ts.
export interface VersionRecording {
  agent: string;
  request: string;
  reply: { summary: string; set: Record<string, unknown> };
}

export const VERSION_RECORDINGS: VersionRecording[] = [
  {
    agent: 'Pasted Text Digest',
    request: 'Also return how many minutes the pasted text takes to read',
    reply: {
      summary: 'Added a reading time for the pasted text, in whole minutes, next to the bullet points.',
      set: {
        systemPrompt:
          'You are Pasted Text Digest. Your job: Summarise any pasted text into three short bullet points for busy readers\n\nMethod:\n1. Read the request field carefully and decide what is being asked.\n2. Use a tool only when the answer depends on information you do not have.\n3. Write the answer in plain language, short and specific.\n4. Count the words of the pasted text, divide by 230 and round up: that is reading_minutes, at least 1.\n5. If the request is unclear or unsafe, say so in the answer field and stop.\n\nQuality bar: every claim in the answer must come from the input or from a tool result.',
        output: [
          { name: 'answer', type: 'text', description: 'The result, in plain language', required: true },
          { name: 'confidence', type: 'string', description: 'How sure the agent is', required: true, enum: ['high', 'medium', 'low'] },
          { name: 'reading_minutes', type: 'integer', description: 'Minutes the pasted text takes to read, at 230 words a minute', required: true },
        ],
      },
    },
  },
];
