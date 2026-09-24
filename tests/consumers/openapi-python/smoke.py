"""A Python consumer of the connector API, through a generated client.

The client under ./generated/ is produced from docs/openapi/connectors.openapi.json
by openapi-python-client (pinned in requirements.txt). It does not exist until
tests/openapi-python-client.test.ts generates it, and that test also starts the
server this script talks to: the real connector handler from the command
harness, behind a loopback HTTP listener.

Everything except the provider's redirect goes through generated functions and
models. The redirect is what a person's browser does between leaving the
provider and landing on the callback, not something an API client calls, so it
is made with the generated client's own httpx session.

The script prints one JSON object of observations on stdout. It carries
references, states and status codes only: no presentation URL, no
authorization code and no callback state.
"""

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent / "generated"))

import httpx  # noqa: E402

from ceremony_connectors import Client  # noqa: E402
from ceremony_connectors.api.bindings import approve_binding, list_bindings  # noqa: E402
from ceremony_connectors.api.catalog import list_catalog  # noqa: E402
from ceremony_connectors.api.connections import (  # noqa: E402
    connect,
    get_connection,
    list_connections,
)
from ceremony_connectors.api.definitions import (  # noqa: E402
    get_definition,
    import_definition,
)
from ceremony_connectors.models import (  # noqa: E402
    AgentConnectionView,
    BindingApprovalRequest,
    BindingApprovalRequestApprovals,
    BindingReference,
    CatalogResponse,
    ConnectionListResponse,
    ConnectRequest,
    ConnectRequestIntent,
    DefinitionReview,
    HumanConnectionView,
    ImportRequestType0,
    ImportResult,
)
from ceremony_connectors.models.list_connections_lifecycle import (  # noqa: E402
    ListConnectionsLifecycle,
)


def expect(value, kind, what):
    if not isinstance(value, kind):
        raise SystemExit(f"{what}: expected {kind.__name__}, got {type(value).__name__}")
    return value


def main() -> None:
    config = json.loads(os.environ["CEREMONY_CLIENT_CONFIG"])
    origin = config["origin"]

    def client(session: str) -> Client:
        return Client(
            base_url=config["baseUrl"],
            cookies={config["cookie"]: session},
            follow_redirects=False,
            raise_on_unexpected_status=True,
        )

    person = client(config["person"])
    observed: dict = {}

    catalog = expect(list_catalog.sync(client=person), CatalogResponse, "catalog")
    observed["catalogIsList"] = isinstance(catalog.entries, list)

    imported = expect(
        import_definition.sync(
            client=person,
            origin=origin,
            body=ImportRequestType0(
                kind="upload", media_type="application/json", text=config["document"]
            ),
        ),
        ImportResult,
        "import",
    )
    definition_ref = imported.definitions[0]
    observed["definitionRef"] = definition_ref

    review = expect(
        get_definition.sync(definition_ref, client=person), DefinitionReview, "review"
    )
    observed["reviewedRef"] = review.definition.definition_ref

    binding = expect(
        approve_binding.sync(
            client=person,
            origin=origin,
            body=BindingApprovalRequest(
                definition_ref=definition_ref,
                adapter_id="fixture-http",
                approvals=BindingApprovalRequestApprovals(
                    destinations=[config["providerOrigin"]],
                    operations=["listItems"],
                    profile_id="oauth",
                    permitted_targets=[],
                ),
            ),
        ),
        BindingReference,
        "binding",
    )
    observed["bindingStatus"] = binding.status.value
    observed["bindingListed"] = any(
        item.binding_ref == binding.binding_ref
        for item in list_bindings.sync(client=person).bindings
    )

    pending = expect(
        connect.sync(
            client=person,
            origin=origin,
            body=ConnectRequest(
                binding_ref=binding.binding_ref,
                intent=ConnectRequestIntent(
                    profile_id="oauth", requested_permissions=["read"]
                ),
            ),
        ),
        HumanConnectionView,
        "connect",
    )
    observed["connectLifecycle"] = pending.lifecycle.value
    listed = expect(
        list_connections.sync(
            client=person, lifecycle=ListConnectionsLifecycle.AUTHORIZATION_REQUIRED
        ),
        ConnectionListResponse,
        "list",
    )
    observed["listed"] = [item.connection_ref for item in listed.connections]

    # The person's browser: to the provider, and back to the callback it names.
    authorize = httpx.get(pending.presentation.url, follow_redirects=False)
    location = urlsplit(authorize.headers["location"])
    callback = person.get_httpx_client().get(f"{location.path}?{location.query}")
    observed["callbackStatus"] = callback.status_code

    after = expect(
        get_connection.sync(pending.connection_ref, client=person),
        HumanConnectionView,
        "after callback",
    )
    observed["afterCallback"] = after.lifecycle.value

    assistant = client(config["assistant"])
    seen = get_connection.sync(pending.connection_ref, client=assistant)
    observed["assistantView"] = type(seen).__name__
    observed["assistantVerified"] = expect(
        seen, AgentConnectionView, "assistant view"
    ).verified

    missing = get_connection.sync_detailed("connection:missing", client=person)
    observed["missing"] = [int(missing.status_code), missing.parsed.error.value]

    refused = import_definition.sync_detailed(
        client=person,
        origin="https://elsewhere.example",
        body=ImportRequestType0(
            kind="upload", media_type="application/json", text=config["document"]
        ),
    )
    observed["crossSite"] = [int(refused.status_code), refused.parsed.error.value]

    print(json.dumps(observed))


if __name__ == "__main__":
    main()
