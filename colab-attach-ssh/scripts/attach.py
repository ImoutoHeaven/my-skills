"""Register a currently active Colab assignment in local CLI state; never allocate a VM."""
import argparse

from colab_cli.common import AuthProvider, State
from colab_cli.state import SessionState


def attach(state, name, endpoint=None):
    assignments = state.client.list_assignments()
    if not assignments:
        raise ValueError('No active Colab runtime. Start the intended notebook runtime first.')
    if endpoint:
        matches = [item for item in assignments if item.endpoint == endpoint]
        if len(matches) != 1:
            raise ValueError('Endpoint is not an active assignment; run colab sessions again.')
        selected = matches[0]
    elif len(assignments) == 1:
        selected = assignments[0]
    else:
        endpoints = ', '.join(item.endpoint for item in assignments)
        raise ValueError('Multiple active runtimes; select one with --endpoint: ' + endpoints)

    previous = state.store.get(name)
    live = {item.endpoint for item in assignments}
    if previous and previous.endpoint != selected.endpoint and previous.endpoint in live:
        raise ValueError('Alias already points to another active runtime; choose --name.')

    proxy = selected.runtime_proxy_info
    if previous and previous.endpoint == selected.endpoint:
        previous.url = proxy.url
        previous.token = proxy.token
        previous.token_expires_at = proxy.expires_at()
        registered = previous
    else:
        registered = SessionState(name=name, endpoint=selected.endpoint, url=proxy.url,
                                  token=proxy.token, token_expires_at=proxy.expires_at(),
                                  accelerator=selected.accelerator.name, variant=selected.variant.name,
                                  machine_shape=selected.machine_shape.name)
    state.store.add(registered)
    return selected.endpoint


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint', help='Exact endpoint shown by colab sessions')
    parser.add_argument('--name', default='colab-attached', help='Local alias (default: colab-attached)')
    parser.add_argument('--config', help='Colab CLI session state file')
    parser.add_argument('--client-oauth-config', help='Colab CLI OAuth client config file')
    parser.add_argument('--auth', choices=['oauth2', 'adc'], default='oauth2', help='Colab CLI authentication strategy')
    args = parser.parse_args()
    state = State()
    state.config_path = args.config
    if args.client_oauth_config:
        state.client_oauth_config = args.client_oauth_config
    state.auth_provider = AuthProvider(args.auth)
    try:
        endpoint = attach(state, args.name, args.endpoint)
    except ValueError as error:
        parser.exit(2, str(error) + '\n')
    print(f'Registered existing assignment [{args.name}] {endpoint}; no VM was created or stopped.')


if __name__ == '__main__':
    main()
