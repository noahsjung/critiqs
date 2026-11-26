# frozen_string_literal: true

require "test_helper"

# Every layout the setup adapter (packages/critiqs/bin/frameworks/rails.mjs)
# writes in its tests, compiled with Rails's ERB handler and parsed. `bun
# scripts/gem.ts test` runs those tests first and saves the layouts here.
class AdapterLayoutsTest < ActiveSupport::TestCase
  include LayoutAssertions

  DIR = File.expand_path("../tmp/adapter-layouts", __dir__)

  test "every layout the setup adapter writes is valid ERB that calls critiqs_tag once" do
    layouts = Dir[File.join(DIR, "*.erb")].sort
    skip "No adapter layouts in #{DIR}: run `bun scripts/gem.ts test`." if layouts.empty?
    assert_operator layouts.size, :>=, 10
    layouts.each { |path| assert_layout_compiles File.read(path), name: File.basename(path) }
  end
end
