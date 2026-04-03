import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Isolator-V — Execution Console",
  description: "WASM sandbox execution environment with real-time telemetry",
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: "#08080a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // "dark" is the server-rendered default; the inline script below
    // overrides it to "light" before the first paint if the user has
    // previously selected light mode.  suppressHydrationWarning silences
    // the React mismatch warning that would otherwise fire when the
    // script changes the class before hydration.
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Anti-flash: read localStorage and apply the correct theme class
            synchronously before the browser paints the first frame.        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='light'){document.documentElement.classList.remove('dark');document.documentElement.classList.add('light');}}catch(e){}})();`,
          }}
        />
        {/* JetBrains Mono for terminal authenticity */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="h-screen overflow-hidden bg-[var(--color-void)]">
        {children}
      </body>
    </html>
  );
}
