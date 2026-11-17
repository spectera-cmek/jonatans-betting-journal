import { ResetPasswordForm } from "./ResetPasswordForm";

export const dynamic = "force-dynamic";

// Fristående sida (utanför (app)-gruppen, som /login): sätt nytt lösenord med
// en återställningslänk från `npm run user:reset-link`.
export default function ResetPasswordPage({ searchParams }: { searchParams: { token?: string } }) {
  return <ResetPasswordForm token={typeof searchParams.token === "string" ? searchParams.token : ""} />;
}
