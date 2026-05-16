export const runtime = 'edge';

export async function GET() {
  const quotaData = [
    { model: 'gemma-4-31b-it', limit: 1500, used: 544, percent: 36.27 },
    { model: 'gemini-2.5-flash', limit: 20, used: 21, percent: 100 },
  ];
  return Response.json(quotaData);
}
