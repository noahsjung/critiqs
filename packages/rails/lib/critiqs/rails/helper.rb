# frozen_string_literal: true

module Critiqs
  module Rails
    module Helper
      # Adds Critiqs to the page: a <critiqs-app> element carrying the page's
      # route as its data-critiqs-context attribute, the gem's small module
      # that reports that context to the element whenever it changes (Turbo
      # visits and morph refreshes too), and the module that defines the
      # element. Put it once in the layout's <body>.
      #
      #   <%= critiqs_tag %>
      #   <%= critiqs_tag(project_id: "j1…", backend: "https://…") %>
      #
      # project_id         - The Critiqs project. Defaults to ENV["CRITIQS_PROJECT_ID"],
      #                      read on each render.
      # require_project_id - Show Critiqs only where project_id is set (default true).
      #                      Where it's blank, the tag renders nothing at all. Pass
      #                      false to show project setup when there's no ID.
      # backend            - A team's own Critiqs backend URL, when not Critiqs Cloud.
      # version            - The prototype's version, such as a release or commit,
      #                      recorded with each message.
      # screen             - The screen threads on this page belong to. Defaults to
      #                      the matched route's pattern, such as "users/:id", with
      #                      its parameters as view state ("route.id" => "42").
      #                      Pass false to let Critiqs use the URL path instead.
      # html_options       - Other attributes for <critiqs-app>, such as id.
      #
      # Both scripts get the request's CSP nonce when the app configures one;
      # there's no inline script.
      def critiqs_tag(project_id: ENV["CRITIQS_PROJECT_ID"], require_project_id: true, backend: nil, version: nil, screen: nil, **html_options)
        project_id = project_id.presence
        return "".html_safe if require_project_id && project_id.nil?

        context = critiqs_route_context(screen)
        attributes = html_options.merge(
          "project-id" => project_id,
          "backend" => backend.presence,
          "version" => version.presence,
          "require-project-id" => require_project_id ? "" : nil,
          "data-critiqs-context" => context&.to_json,
        ).compact
        safe_join([
          content_tag("critiqs-app", nil, attributes),
          javascript_include_tag(CONTEXT_ASSET, ELEMENT_ASSET, type: "module", nonce: true),
        ])
      end

      private

      # What this page reports: the screen and the route's parameters as view
      # state, following the critiqs package's routeContext. nil without a
      # screen, so Critiqs falls back to the URL path.
      def critiqs_route_context(screen)
        return nil if screen == false

        matched = respond_to?(:request) ? request : nil
        screen ||= Critiqs::Rails.route_screen(matched&.route_uri_pattern)
        return nil if screen.blank?

        params = matched ? matched.path_parameters.except(:controller, :action, :format) : {}
        # A repeated parameter (a glob, ":path*") keeps its segments apart, each one's own % escaped.
        repeated = screen.to_s.scan(%r{(?:\A|/):([\w-]+)[*+](?=/|\z)}).flatten
        view_state = params.to_h do |name, value|
          value = value.to_s
          value = value.split("/", -1).map { |segment| segment.gsub("%", "%25") }.join("/") if repeated.include?(name.to_s)
          ["route.#{name}", value]
        end
        { screen: screen, viewState: view_state }
      end
    end

    # A Rails route pattern in the critiqs package's screen form: "/users/:id(.:format)"
    # becomes "users/:id", an optional parameter "(/:page)" becomes ":page?", a
    # glob "*path" becomes ":path*", and the root route is "/". nil without a
    # pattern, or when the critiqs package's routePath couldn't build the
    # page's path back from the screen, so Critiqs uses the URL path there:
    # another optional part, such as "(/page/:page)" (no screen gives both
    # /posts and /posts/page/2), or a parameter inside a segment, such as
    # "release-:version" (routePath fills in only whole segments).
    def self.route_screen(pattern)
      return nil if pattern.blank?

      path = pattern.delete_suffix("(.:format)")
                    .gsub(%r{\((/?):(\w+)\)}, '\1:\2?')
                    .gsub(%r{\((/?)\*(\w+)\)}, '\1*\2')
                    .gsub(/\*(\w+)/, ':\1*')
      return nil if path.match?(/[()]/)
      return nil unless path.split("/").all? { |segment| !segment.match?(/[:*]/) || segment.match?(/\A:\w+[?*]?\z/) }

      path = path.gsub(%r{\A/+|/+\z}, "")
      path.empty? ? "/" : path
    end
  end
end
