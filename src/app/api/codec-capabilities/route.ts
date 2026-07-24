import { CODEC_REGISTRY_REVISION, SUPPORTED_CODEC_FORMATS } from "@/codec-registry";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      decoderRevision: CODEC_REGISTRY_REVISION,
      formats: SUPPORTED_CODEC_FORMATS
    },
    { headers: { "Cache-Control": "public, max-age=60" } }
  );
}
