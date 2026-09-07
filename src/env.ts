import "dotenv/config";

/** Eksik env degiskenini sessizce gecmek yerine erken patlat. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Eksik environment degiskeni: ${name}. .env dosyasini kontrol et (.env.example'a bak).`
    );
  }
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}
