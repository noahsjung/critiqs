# frozen_string_literal: true

require "test_helper"

class CritiqsTagTest < ActionView::TestCase
  PROJECT = "j12345678901234567890123456789012"

  setup { @saved = ENV.delete("CRITIQS_PROJECT_ID") }
  teardown { @saved.nil? ? ENV.delete("CRITIQS_PROJECT_ID") : ENV["CRITIQS_PROJECT_ID"] = @saved }

  def page(template)
    Nokogiri::HTML5.fragment(render(inline: template))
  end

  def asset_src(path) = "/assets/#{Rails.application.assets.load_path.find(path).digested_path}"
  def element_src = asset_src("critiqs/element.js")
  def context_src = asset_src("critiqs/context.js")
  def script_srcs(html) = html.css("script").map { _1["src"] }

  test "reads the project ID from CRITIQS_PROJECT_ID and requires it" do
    ENV["CRITIQS_PROJECT_ID"] = PROJECT
    html = page("<%= critiqs_tag %>")
    app = html.at_css("critiqs-app")
    assert_equal PROJECT, app["project-id"]
    assert app.key?("require-project-id")
    assert_equal [context_src, element_src], script_srcs(html)
    assert html.css("script").all? { _1["type"] == "module" }
  end

  test "renders nothing where CRITIQS_PROJECT_ID is unset or blank" do
    assert_equal "", render(inline: "<%= critiqs_tag %>")
    ENV["CRITIQS_PROJECT_ID"] = "  "
    assert_equal "", render(inline: "<%= critiqs_tag %>")
  end

  test "a project ID in the code wins over the environment" do
    ENV["CRITIQS_PROJECT_ID"] = "jother"
    assert_equal PROJECT, page(%(<%= critiqs_tag(project_id: "#{PROJECT}") %>)).at_css("critiqs-app")["project-id"]
  end

  test "without require_project_id, no ID shows project setup" do
    html = page("<%= critiqs_tag(require_project_id: false) %>")
    app = html.at_css("critiqs-app")
    refute app.key?("project-id")
    refute app.key?("require-project-id")
    assert_equal [context_src, element_src], script_srcs(html)
  end

  test "passes backend, version, and other attributes to the element, escaped" do
    html = page(%(<%= critiqs_tag(project_id: '#{PROJECT}"><b>', backend: "https://team.example/critiqs", version: "v1.2", id: "critiqs") %>))
    app = html.at_css("critiqs-app")
    assert_equal %(#{PROJECT}"><b>), app["project-id"]
    assert_equal "https://team.example/critiqs", app["backend"]
    assert_equal "v1.2", app["version"]
    assert_equal "critiqs", app["id"]
    assert_nil html.at_css("b")
  end

  test "the script carries the request's CSP nonce when the app sets one" do
    ENV["CRITIQS_PROJECT_ID"] = PROJECT
    refute page("<%= critiqs_tag %>").at_css("script[src]").key?("nonce")
    request.content_security_policy_nonce_generator = ->(_request) { "n0nce" }
    assert_equal "n0nce", page("<%= critiqs_tag %>").at_css("script[src]")["nonce"]
  end

  def on_route(pattern, **params)
    request.set_header("action_dispatch.route_uri_pattern", pattern)
    request.path_parameters = { controller: "users", action: "show", format: "html", **params }
  end

  # The context critiqs_tag hands to the element; nil without one.
  def pushed_context(html)
    context = html.at_css("critiqs-app")["data-critiqs-context"]
    context && JSON.parse(context)
  end

  test "reports the matched route as the screen and its parameters as view state" do
    ENV["CRITIQS_PROJECT_ID"] = PROJECT
    on_route("/users/:id(.:format)", id: "42")
    html = page("<%= critiqs_tag %>")
    assert_equal({ "screen" => "users/:id", "viewState" => { "route.id" => "42" } }, pushed_context(html))
    assert_equal %w[critiqs-app script script], html.element_children.map(&:name)
    assert_equal [context_src, element_src], script_srcs(html), "no inline script: the context is an attribute a morph can change"
  end

  test "the root route is the screen /" do
    ENV["CRITIQS_PROJECT_ID"] = PROJECT
    on_route("/")
    assert_equal({ "screen" => "/", "viewState" => {} }, pushed_context(page("<%= critiqs_tag %>")))
  end

  test "a screen given in the view wins, keeping the route's parameters" do
    ENV["CRITIQS_PROJECT_ID"] = PROJECT
    on_route("/users/:id(.:format)", id: "42")
    assert_equal({ "screen" => "user-details", "viewState" => { "route.id" => "42" } }, pushed_context(page(%(<%= critiqs_tag(screen: "user-details") %>))))
  end

  test "screen: false, or no matched route, reports nothing" do
    ENV["CRITIQS_PROJECT_ID"] = PROJECT
    assert_nil pushed_context(page("<%= critiqs_tag %>"))
    on_route("/users/:id(.:format)", id: "42")
    html = page("<%= critiqs_tag(screen: false) %>")
    assert_nil pushed_context(html)
    assert_equal [context_src, element_src], script_srcs(html)
  end

  test "the context is safe for any parameter value, and both scripts carry the nonce" do
    ENV["CRITIQS_PROJECT_ID"] = PROJECT
    request.content_security_policy_nonce_generator = ->(_request) { "n0nce" }
    on_route("/notes/:slug(.:format)", slug: %("></critiqs-app><script>alert(1)</script>))
    html = page("<%= critiqs_tag %>")
    assert_equal 2, html.css("script").size
    assert_equal %("></critiqs-app><script>alert(1)</script>), pushed_context(html)["viewState"]["route.slug"]
    assert html.css("script").all? { |node| node["nonce"] == "n0nce" }
  end

  # A Turbo morph refresh changes the page's elements in place and runs no
  # scripts, so the script that reports the context watches the attribute.
  test "the context script reports the attribute whenever it changes, Turbo or not" do
    script = Rails.application.assets.load_path.find("critiqs/context.js").content
    assert_includes script, "data-critiqs-context"
    assert_includes script, "MutationObserver"
    assert_includes script, "setContext"
  end

  # As the critiqs package's routeContext stores a repeated parameter, so routePath reads it back.
  test "a glob parameter's segments escape their own %" do
    ENV["CRITIQS_PROJECT_ID"] = PROJECT
    on_route("/docs/*path(.:format)", path: "guides/100%/a%2Fb")
    assert_equal({ "screen" => "docs/:path*", "viewState" => { "route.path" => "guides/100%25/a%252Fb" } }, pushed_context(page("<%= critiqs_tag %>")))
    on_route("/notes/:slug(.:format)", slug: "100%")
    assert_equal({ "route.slug" => "100%" }, pushed_context(page("<%= critiqs_tag %>"))["viewState"])
  end

  test "Rails route patterns become screens" do
    {
      "/users/:id(.:format)" => "users/:id",
      "/(.:format)" => "/",
      "/posts(/:page)(.:format)" => "posts/:page?",
      "/(:locale)/posts(.:format)" => ":locale?/posts",
      "/docs/*path(.:format)" => "docs/:path*",
      "/docs(/*path)(.:format)" => "docs/:path*",
      "/teams/:team_id/members/:id" => "teams/:team_id/members/:id",
    }.each { |pattern, screen| assert_equal screen, Critiqs::Rails.route_screen(pattern), pattern }
    assert_nil Critiqs::Rails.route_screen(nil)
  end

  # A screen must turn back into the page's path (critiqs's routePath), and
  # "posts/page/:page" can't give /posts, so these report the URL path.
  test "an optional part that isn't one parameter reports no screen" do
    ["/posts(/page/:page)(.:format)", "/a(/:b(/:c))(.:format)", "/files(.:ext)", "/search(/:q/:page)"].each do |pattern|
      assert_nil Critiqs::Rails.route_screen(pattern), pattern
    end
    ENV["CRITIQS_PROJECT_ID"] = PROJECT
    on_route("/posts(/page/:page)(.:format)")
    assert_nil pushed_context(page("<%= critiqs_tag %>"))
  end

  # routePath rebuilds only whole-segment parameters, so "release-:version" would give no path back.
  test "a parameter inside a segment reports no screen" do
    ["/release-:version(.:format)", "/files/:name.:ext", "/v:major/docs", "/tags/*path.zip"].each do |pattern|
      assert_nil Critiqs::Rails.route_screen(pattern), pattern
    end
    ENV["CRITIQS_PROJECT_ID"] = PROJECT
    on_route("/release-:version(.:format)", version: "1.2")
    assert_nil pushed_context(page("<%= critiqs_tag %>"))
  end

  test "the bundle the script loads is the critiqs element" do
    asset = Rails.application.assets.load_path.find("critiqs/element.js")
    assert asset, "critiqs/element.js isn't on the asset load path"
    assert_includes asset.content, "critiqs-app"
  end
end
