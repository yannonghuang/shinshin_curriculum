// Plug in your own EmailJS account values here (https://www.emailjs.com/).
// login.component.js / register.component.js call emailjs.send(serviceId, templateId, params)
// exactly the way shinshin's login/register components do -- only the ids have been moved
// out of the component code and into this config file so a fresh deployment doesn't need
// to edit component source to go live.
//
// NOTE (security): the link tokens below are signed *client-side* with a shared literal
// secret (see auth.service.js / login.component.js `jwt.sign(..., "config.secret", ...)`).
// This is copied as-is from shinshin for feature parity, but it is not secure -- anyone can
// mint their own "valid" verification/reset link with devtools. Worth hardening later by
// moving link-token issuance to the backend (e.g. the backend signs the token and emails the
// link itself, or at minimum uses a real secret from env that the browser never sees).
const emailjsConfig = {
  // emailjs.init(userId) -- EmailJS "Public Key" for your account.
  // Reused from shinshin (same EmailJS account/service) -- see
  // shinshin/react-app/src/components/login.component.js's init(...) call.
  userId: "user_xpt3ehC4nNeGJBgM579gJ",
  // Service configured in the EmailJS dashboard (e.g. a Gmail/SMTP connection).
  serviceId: "Gmail 2022",
  // Template used for signup / resend "please verify your email" links.
  templateIdEmailVerification: "template_email_check",
  // Template used for "忘记密码" / forgot-password links.
  templateIdPasswordReset: "template_ae0k3bj",
  // Shared literal JWT secret used to sign short-lived email-verification/reset link
  // tokens client-side. Matches shinshin's existing (insecure but functional) pattern.
  jwtSecret: "config.secret",
};

export default emailjsConfig;
