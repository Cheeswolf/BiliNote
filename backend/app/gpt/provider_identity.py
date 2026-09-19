"""Effective model endpoint identity shared by every resumable artifact."""
import os
from urllib.parse import unquote_to_bytes

import httpx


def resolve_base_url(base_url=None) -> str:
    """Resolve the same environment/default fallback used by the OpenAI SDK."""
    if base_url is None:
        base_url = os.getenv('OPENAI_BASE_URL', 'https://api.openai.com/v1')
    url = httpx.URL(str(base_url).strip())
    # Mirror the SDK using raw bytes, preserving escaped slashes and queries.
    return str(url if url.raw_path.endswith(b'/') else url.copy_with(raw_path=url.raw_path + b'/'))


def provider_identity(provider: dict | None) -> dict:
    """Allowlist behavior settings; credentials never participate in identity."""
    provider = provider or {}
    url = httpx.URL(resolve_base_url(provider.get('base_url')))
    secret_fields = {b'key', b'apikey', b'token', b'authorization', b'password',
                     b'secret', b'signature', b'credential'}
    # Preserve raw values, escaping, blanks and ordering: gateways may interpret
    # these differently. Decode only names to recognize encoded credentials.
    parts = []
    for part in url.query.split(b'&'):
        name, separator, value = part.partition(b'=')
        tokens = set(unquote_to_bytes(name).lower().replace(b'-', b'_').split(b'_'))
        # Replace only the value. Removing a credential parameter would alias
        # distinct paths/queries (including the SDK's appended raw-path slash).
        parts.append(name + separator + b'REDACTED' if separator and tokens & secret_fields else part)
    endpoint = url.copy_with(username=None, password=None, fragment=None,
                             query=b'&'.join(parts) if url.query else None)
    return {'base_url': str(endpoint), 'type': provider.get('type'),
            'adapter': 'openai-compatible', 'temperature': 0.7}
