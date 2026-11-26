# frozen_string_literal: true

# A minimal Rails app with Propshaft, the default asset pipeline, and this gem.
ENV["RAILS_ENV"] = "test"
require "logger"
require "rails"
require "action_controller/railtie"
require "action_view/railtie"
require "propshaft"
require "critiqs-rails"

class DummyApp < Rails::Application
  config.root = File.expand_path("../tmp/dummy", __dir__)
  config.eager_load = false
  config.logger = Logger.new(nil)
  config.secret_key_base = "test"
  config.hosts.clear
end
DummyApp.initialize!

require "minitest/autorun"
require "action_view/test_case"
require "rails/generators/test_case"
require "prism"

module LayoutAssertions
  # Compiles an ERB layout the way Rails does and parses the Ruby it becomes,
  # asserting it's valid and calls critiqs_tag `calls` times as Ruby code (not
  # inside a string or a comment).
  def assert_layout_compiles(source, calls: 1, name: "layout")
    ruby = ActionView::Template::Handlers::ERB::Erubi.new(source, trim: true).src
    # Rails compiles each template into a method, where `yield` is valid.
    result = Prism.parse("def template(local_assigns, output_buffer, &_)\n#{ruby}\nend\n")
    assert result.success?, "#{name} doesn't compile:\n#{result.errors.map(&:message).join("\n")}\n#{source}"
    found = []
    walk = ->(node) do
      found << node if node.is_a?(Prism::CallNode) && node.name == :critiqs_tag
      node.compact_child_nodes.each(&walk)
    end
    walk.(result.value)
    assert_equal calls, found.size, "#{name} should call critiqs_tag #{calls} time(s):\n#{source}"
  end
end
