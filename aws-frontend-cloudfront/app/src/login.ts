// index.html: sign in with the API's Cognito user pool, then go to app.html.
import './styles.css';
import { $, errorMessage, setupPage } from './page.js';
import { getValidSession } from './session.js';
import { SignInResult } from './cognito.js';

const page = setupPage();

if (page) {
  const { cognito, sessions } = page;
  const loginForm = $<HTMLFormElement>('#login-form');
  const newPasswordForm = $<HTMLFormElement>('#new-password-form');
  const error = $('#error');
  let username = '';
  let challengeSession = '';

  const showError = (message: string) => {
    error.textContent = message;
    error.hidden = !message;
  };

  const busy = (form: HTMLFormElement, isBusy: boolean) => {
    form.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = isBusy;
    form.setAttribute('aria-busy', String(isBusy));
  };

  const handle = (result: SignInResult) => {
    if (result.kind === 'newPasswordRequired') {
      challengeSession = result.session;
      loginForm.hidden = true;
      newPasswordForm.hidden = false;
      $<HTMLInputElement>('#new-password').focus();
      return;
    }
    sessions.save({ username, ...result.tokens });
    location.replace('app.html');
  };

  const submit = (form: HTMLFormElement, action: () => Promise<SignInResult>) =>
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      showError('');
      busy(form, true);
      try {
        handle(await action());
      } catch (err) {
        showError(errorMessage(err));
      } finally {
        busy(form, false);
      }
    });

  submit(loginForm, () => {
    username = $<HTMLInputElement>('#email').value.trim();
    return cognito.signIn(username, $<HTMLInputElement>('#password').value);
  });

  submit(newPasswordForm, async () => {
    const newPassword = $<HTMLInputElement>('#new-password').value;
    if (newPassword !== $<HTMLInputElement>('#confirm-password').value) throw new Error('The passwords do not match');
    return cognito.completeNewPassword(username, newPassword, challengeSession);
  });

  // Already signed in: skip the form.
  getValidSession(sessions, cognito)
    .then((session) => session && location.replace('app.html'))
    .catch(() => undefined);
}
