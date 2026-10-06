// The site's only page: shows which environment and release it is, so an activation or a
// rollback is visible. Sign-in and the API page are out of scope for now (see git history, PR #23).
import './styles.css';
import { loadConfig } from './config.js';

const config = loadConfig();
const set = (id: string, text: string) => {
  document.getElementById(id)!.textContent = text;
};

set('name', config.env === 'local' ? 'frontend-user' : `frontend-user-${config.env}`);
set('env', config.env);
set('release', config.releaseId);
set('footer-release', config.releaseId);
set('built', config.builtAt ? new Date(config.builtAt).toUTCString() : 'local build');
