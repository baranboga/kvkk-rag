import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // postgres-js Node soketleri kullanir; Next'in bundle etmeye calismasi
  // yerine runtime'da require edilsin.
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
