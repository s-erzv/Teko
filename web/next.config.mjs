/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keluaran HTML statis murni: tidak ada server, tidak ada function.
  // Netlify menyajikannya langsung dari CDN.
  output: "export",
  // Optimasi gambar Next butuh server; matikan untuk export statis.
  images: { unoptimized: true },
};

export default nextConfig;
