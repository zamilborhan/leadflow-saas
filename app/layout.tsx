import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

// Single external font provider, minimal weights: body (400/500/600/700)
// + mono only for code/ids. `display: swap` keeps text visible during load
// and CSS variables avoid layout shift (no FOUT-driven CLS).
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  preload: true,
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  preload: false,
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#4f46e5",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://leadflow.app"),
  title: {
    default: "LeadFlow — Turn leads into customers",
    template: "%s — LeadFlow",
  },
  description: "LeadFlow captures every lead, assigns it to the right agent, and keeps follow-up consistent — from first click to closed deal.",
  applicationName: "LeadFlow",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon.png", sizes: "512x512", type: "image/png" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    siteName: "LeadFlow",
    title: "LeadFlow — Turn leads into customers",
    description: "Capture every lead, assign it to the right agent, and keep WhatsApp follow-up consistent.",
  },
  twitter: {
    card: "summary_large_image",
    title: "LeadFlow — Turn leads into customers",
    description: "Capture every lead, assign it to the right agent, and keep follow-up consistent.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
