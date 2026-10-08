import { FormEvent, useState } from 'react';
import { AuthError, completeNewPassword, NewPasswordRequired, signIn } from '../auth.js';
import { Icon } from './Icon.js';

/** What to show for Cognito's errors; anything else shows Cognito's own message. */
function messageOf(err: unknown): string {
  if (err instanceof AuthError) {
    if (err.type === 'NotAuthorizedException' && /temporary password has expired/i.test(err.message)) {
      return 'Your temporary password has expired. Ask an administrator to send you a new one.';
    }
    if (err.type === 'NotAuthorizedException' || err.type === 'UserNotFoundException') return 'Wrong email or password.';
    if (err.type === 'PasswordResetRequiredException') return 'Your password was reset. Ask an administrator for a new invitation.';
    if (err.type === 'TooManyRequestsException' || err.type === 'LimitExceededException') return 'Too many attempts. Wait a minute and try again.';
    return err.message;
  }
  return 'Could not reach the sign-in service. Check your connection and try again.';
}

class PasswordMismatch extends Error {}

/**
 * The sign-in form. Accounts are invite only: there is no sign-up. An invited user's first sign-in,
 * with the temporary password from the invitation email, continues with choosing their own password.
 */
export function Login({ env }: { env: string }) {
  const [challenge, setChallenge] = useState<NewPasswordRequired>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = (action: (form: FormData) => Promise<void>) => async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await action(new FormData(event.currentTarget));
    } catch (err) {
      setError(err instanceof PasswordMismatch ? 'The two passwords differ.' : messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const signInWith = submit(async (form) => {
    const next = await signIn(String(form.get('email')).trim(), String(form.get('password')));
    if (next) setChallenge(next);
  });
  const setPassword = submit(async (form) => {
    const password = String(form.get('new-password'));
    if (password !== String(form.get('new-password-confirm'))) throw new PasswordMismatch();
    await completeNewPassword(challenge!, password);
  });

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-brand"><Icon name="cube" />AWS Control Center <span className="login-env">{env}</span></div>
        {!challenge ? (
          <form id="login" onSubmit={signInWith} aria-busy={busy}>
            <h1>Sign in</h1>
            <p className="login-hint">Access is by invitation only.</p>
            <label>Email<input id="login-email" name="email" type="email" autoComplete="username" required autoFocus /></label>
            <label>Password<input id="login-password" name="password" type="password" autoComplete="current-password" required /></label>
            {error && <p id="login-error" className="login-error" role="alert">{error}</p>}
            <button id="login-submit" type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        ) : (
          <form id="new-password" onSubmit={setPassword} aria-busy={busy}>
            <h1>Choose your password</h1>
            <p className="login-hint">
              Welcome, {challenge.email}. Replace your temporary password: at least 12 characters, with upper and
              lower case letters, a digit and a symbol.
            </p>
            {/* lets password managers save the new password under the right account */}
            <input type="email" name="email" autoComplete="username" value={challenge.email} readOnly hidden />
            <label>New password<input id="new-password-input" name="new-password" type="password" autoComplete="new-password" minLength={12} required autoFocus /></label>
            <label>Repeat it<input id="new-password-confirm" name="new-password-confirm" type="password" autoComplete="new-password" minLength={12} required /></label>
            {error && <p id="login-error" className="login-error" role="alert">{error}</p>}
            <button id="new-password-submit" type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Set password and sign in'}</button>
          </form>
        )}
      </div>
    </main>
  );
}
