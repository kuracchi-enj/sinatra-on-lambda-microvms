# frozen_string_literal: true

ENV["RACK_ENV"] = "test"

require "minitest/autorun"
require "rack/test"
require_relative "../app"

class AppTest < Minitest::Test
  include Rack::Test::Methods

  def app
    App
  end

  def setup
    App.settings.lifecycle_mutex.synchronize do
      App.settings.ready = false
      App.settings.generation = "unassigned"
      App.settings.microvm_id = nil
      App.settings.runtime_initialized = false
    end
  end

  def parsed_body
    JSON.parse(last_response.body)
  end

  def hook(path, body = {})
    post "#{App::HOOK_PREFIX}/#{path}", JSON.generate(body), {
      "CONTENT_TYPE" => "application/json"
    }
  end

  def test_root_returns_contract_and_request_id
    get "/", {}, "HTTP_X_REQUEST_ID" => "request-123"

    assert last_response.ok?
    assert_equal "Sinatra on Lambda MicroVMs", parsed_body["message"]
    assert_equal "unassigned", parsed_body["generation"]
    assert_equal "request-123", last_response["X-Request-Id"]
    assert_equal "no-store", last_response["Cache-Control"]
  end

  def test_readiness_tracks_lifecycle
    get "/health/ready"
    assert_equal 503, last_response.status

    hook "ready"
    get "/health/ready"
    assert_equal 503, last_response.status

    hook "run", {
      "microvmId" => "mvm-1",
      "runHookPayload" => JSON.generate("generation" => 1)
    }
    get "/health/ready"
    assert_equal 200, last_response.status

    hook "suspend"
    get "/health/ready"
    assert_equal 503, last_response.status

    hook "resume"
    get "/health/ready"
    assert_equal 200, last_response.status
  end

  def test_run_initializes_runtime_identity_from_official_payload
    hook "run", {
      "microvmId" => "mvm-expected",
      "runHookPayload" => JSON.generate("generation" => 7)
    }

    assert_equal 200, last_response.status
    refute parsed_body["duplicate"]

    get "/"
    assert_equal 7, parsed_body["generation"]
  end

  def test_run_is_idempotent_for_the_same_runtime_identity
    payload = {
      "microvmId" => "mvm-expected",
      "runHookPayload" => JSON.generate("generation" => 7)
    }
    hook "run", payload
    hook "run", payload

    assert_equal 200, last_response.status
    assert parsed_body["duplicate"]
  end

  def test_run_rejects_a_different_runtime_identity_after_initialization
    hook "run", {
      "microvmId" => "mvm-expected",
      "runHookPayload" => JSON.generate("generation" => 7)
    }
    hook "run", {
      "microvmId" => "mvm-other",
      "runHookPayload" => JSON.generate("generation" => 8)
    }

    assert_equal 409, last_response.status
    assert_equal "runtime_identity_mismatch", parsed_body["error"]
  end

  def test_run_requires_the_service_supplied_microvm_id
    hook "run", "runHookPayload" => JSON.generate("generation" => 1)

    assert_equal 400, last_response.status
    assert_equal "microvm_id_required", parsed_body["error"]
  end

  def test_resume_before_run_fails_closed
    hook "resume"

    assert_equal 503, last_response.status
    assert_equal "runtime_not_initialized", parsed_body["error"]
  end

  def test_invalid_request_id_is_replaced
    get "/", {}, "HTTP_X_REQUEST_ID" => "invalid request id"

    refute_equal "invalid request id", last_response["X-Request-Id"]
    assert_match(/\A[0-9a-f-]{36}\z/, last_response["X-Request-Id"])
  end
end
