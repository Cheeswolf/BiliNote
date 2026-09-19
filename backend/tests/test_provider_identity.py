"""Cache identity follows actual SDK requests while excluding credential values."""
import json

import httpx
from openai import OpenAI
import pytest

from app.gpt.provider_identity import provider_identity


def request_target(endpoint):
    targets = []
    def respond(request):
        targets.append(request.url.raw_path)
        return httpx.Response(200, json={"choices": []})
    with OpenAI(api_key='offline-header-key', base_url=endpoint,
                http_client=httpx.Client(transport=httpx.MockTransport(respond))) as client:
        client.chat.completions.create(model='fixture', messages=[])
        identity = provider_identity({'base_url': client.base_url})
        assert identity == provider_identity({'base_url': endpoint})
    return targets[0], identity


@pytest.mark.parametrize('first, second, first_target, second_target', [
    ('/v1?api_key=fixture-one', '/v1/?api_key=fixture-one',
     b'/v1?api_key=fixture-one/chat/completions', b'/v1/?api_key=fixture-one/chat/completions'),
    ('/v1/?api_key=fixture-one', '/v1/',
     b'/v1/?api_key=fixture-one/chat/completions', b'/v1/chat/completions'),
    ('/v1/?api_key=fixture-one&deployment=a/', '/v1/?deployment=a/&api_key=fixture-one',
     b'/v1/?api_key=fixture-one&deployment=a/chat/completions',
     b'/v1/?deployment=a/&api_key=fixture-one/chat/completions'),
    ('/v1/?api_key&deployment=a/', '/v1/?api_key=&deployment=a/',
     b'/v1/?api_key&deployment=a/chat/completions', b'/v1/?api_key=&deployment=a/chat/completions'),
    ('/v1/?deployment=%FF/&api_key=fixture-one', '/v1/?deployment=%FE/&api_key=fixture-one',
     b'/v1/?deployment=%FF/&api_key=fixture-one/chat/completions',
     b'/v1/?deployment=%FE/&api_key=fixture-one/chat/completions'),
    ('/v1/?deployment=a%2Fb/&api_key=fixture-one', '/v1/?deployment=a/b/&api_key=fixture-one',
     b'/v1/?deployment=a%2Fb/&api_key=fixture-one/chat/completions',
     b'/v1/?deployment=a/b/&api_key=fixture-one/chat/completions'),
    ('/v1/?flag&api_key=fixture-one', '/v1/?flag=&api_key=fixture-one',
     b'/v1/?flag&api_key=fixture-one/chat/completions', b'/v1/?flag=&api_key=fixture-one/chat/completions'),
])
def test_distinct_sdk_request_targets_do_not_share_identity(first, second, first_target, second_target):
    actual_first, first_identity = request_target('https://fixture.example' + first)
    actual_second, second_identity = request_target('https://fixture.example' + second)
    assert actual_first == first_target
    assert actual_second == second_target
    assert first_identity != second_identity


@pytest.mark.parametrize('query', [
    'api_key={key}', 'api_key={key}&deployment=a/',
    'deployment=a/&api_key={key}&flag', 'api%5Fkey={key}&token={key}',
])
def test_credential_rotation_at_same_query_location_reuses_identity(query):
    first_url = 'https://user:fixture-password@fixture.example/v1/?' + query.format(key='fixture-one')
    second_url = 'https://user:rotated-password@fixture.example/v1/?' + query.format(key='fixture-two')
    _, first = request_target(first_url)
    _, second = request_target(second_url)
    assert first == second
    serialized = json.dumps(first)
    for secret in ('fixture-one', 'fixture-two', 'fixture-password', 'rotated-password', 'offline-header-key'):
        assert secret not in serialized
