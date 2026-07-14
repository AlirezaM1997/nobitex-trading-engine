import "@fontsource/estedad/400.css";
import "@fontsource/estedad/600.css";
import "@fontsource/estedad/700.css";
import "./globals.css";

export const metadata = { title: "ترمینال استراتژی‌های نوبیتکس", description: "آربیتراژ مثلثی محافظت‌شده و Strategy Lab چندمدلی نوبیتکس" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="fa" dir="rtl"><body>{children}</body></html>;
}
