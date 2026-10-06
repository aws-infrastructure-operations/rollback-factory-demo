// app.html: calls GET and POST on /users and /messages of api-user-<env> with the ID token.
import './styles.css';
import { $, errorMessage, setupPage } from './page.js';
import { decodeJwtPayload, getValidSession } from './session.js';
import { ApiResponse, createApiClient, RESOURCES, Resource } from './api.js';

const toLogin = () => location.replace('index.html');

const page = setupPage();

if (page) {
  const { config, cognito, sessions } = page;
  const session = await getValidSession(sessions, cognito).catch(() => sessions.load());

  if (!session) {
    toLogin();
  } else {
    const claims = decodeJwtPayload(session.idToken);
    $('#user').textContent = String(claims.email ?? session.username);
    $('#sign-out').addEventListener('click', () => {
      sessions.clear();
      toLogin();
    });

    const api = createApiClient({
      baseUrl: config.apiUrl,
      getIdToken: async () => {
        const current = await getValidSession(sessions, cognito);
        if (!current) {
          toLogin();
          throw new Error('Your session has expired, please sign in again');
        }
        return current.idToken;
      },
    });

    const template = $<HTMLTemplateElement>('#resource-template');
    for (const resource of RESOURCES) $('#resources').append(renderResource(template, resource, api));
  }
}

function renderResource(template: HTMLTemplateElement, resource: Resource, api: ReturnType<typeof createApiClient>) {
  const section = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  const q = <T extends HTMLElement>(selector: string) => section.querySelector<T>(selector)!;
  const titleId = `${resource}-title`;
  section.setAttribute('aria-labelledby', titleId);
  q('h2').id = titleId;
  q('h2').textContent = `/${resource}`;
  q<HTMLLabelElement>('label').htmlFor = `${resource}-message`;
  q<HTMLInputElement>('input').id = `${resource}-message`;
  q('[data-get]').textContent = `GET /${resource}`;
  q('[data-post]').textContent = `POST /${resource}`;

  const status = q('[data-status]');
  const output = q('[data-output]');
  const show = (label: string, response?: ApiResponse, error?: unknown) => {
    status.className = `status ${response?.ok ? 'ok' : 'failed'}`;
    status.textContent = response ? `${label} → ${response.status}` : `${label} → ${errorMessage(error)}`;
    output.textContent = response ? JSON.stringify(response.body, null, 2) : '';
    output.hidden = !response;
  };
  const run = async (label: string, call: () => Promise<ApiResponse>, button: HTMLButtonElement) => {
    button.disabled = true;
    status.className = 'status';
    status.textContent = `${label} …`;
    try {
      show(label, await call());
    } catch (err) {
      show(label, undefined, err);
    } finally {
      button.disabled = false;
    }
  };

  q<HTMLButtonElement>('[data-get]').addEventListener('click', (event) =>
    run(`GET /${resource}`, () => api.get(resource), event.currentTarget as HTMLButtonElement));
  q<HTMLFormElement>('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const message = q<HTMLInputElement>('input').value;
    run(`POST /${resource}`, () => api.post(resource, message), q<HTMLButtonElement>('[data-post]'));
  });
  return section;
}
