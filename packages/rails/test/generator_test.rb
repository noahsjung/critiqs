# frozen_string_literal: true

require "test_helper"
require "generators/critiqs/install/install_generator"

class InstallGeneratorTest < Rails::Generators::TestCase
  include LayoutAssertions
  tests Critiqs::Generators::InstallGenerator
  destination File.expand_path("../tmp/generator", __dir__)
  setup :prepare_destination
  setup { write_gemfile(GEMFILE) }

  LAYOUT = "app/views/layouts/application.html.erb"
  # The layout `rails new` writes (Rails 8.1).
  STARTER = File.read(File.expand_path("fixtures/application.html.erb", __dir__))

  # The Gemfile `rails new` writes (Rails 8.1), trimmed, with the gem added as `bundle add` does.
  GEMFILE = <<~RUBY
    source "https://rubygems.org"

    gem "rails", "~> 8.1.4", ">= 8.1.4.1"
    gem "propshaft"

    group :development, :test do
      gem "debug", platforms: %i[ mri windows ], require: "debug/prelude"
    end

    gem "critiqs-rails"
  RUBY

  def write_gemfile(source) = File.write(File.join(destination_root, "Gemfile"), source)

  def write_layout(source)
    path = File.join(destination_root, LAYOUT)
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, source)
  end

  def layout = File.read(File.join(destination_root, LAYOUT))

  # Every layout the generator writes compiles as Rails reads it, with one critiqs_tag call.
  def run_generator(*)
    output = super
    assert_layout_compiles layout if File.exist?(File.join(destination_root, LAYOUT)) && layout.include?("critiqs_tag")
    output
  end

  test "adds the tag to the starter layout, indented like the body's content" do
    write_layout(STARTER)
    run_generator
    assert_file LAYOUT, STARTER.sub("    <%= yield %>\n", "    <%= yield %>\n    <%= critiqs_tag %>\n")
  end

  test "a second run changes nothing" do
    write_layout(STARTER)
    run_generator
    once = File.read(File.join(destination_root, LAYOUT))
    output = run_generator
    assert_file LAYOUT, once
    assert_match "already has critiqs_tag", output
  end

  test "keeps tabs and Windows line endings" do
    write_layout("<html>\r\n\t<body>\r\n\t\t<%= yield %>\r\n\t</body>\r\n</html>\r\n")
    run_generator
    assert_file LAYOUT, "<html>\r\n\t<body>\r\n\t\t<%= yield %>\r\n\t\t<%= critiqs_tag %>\r\n\t</body>\r\n</html>\r\n"
  end

  test "</body> on a line with other markup gets the tag right before it" do
    write_layout("<html><body><%= yield %></body></html>\n")
    run_generator
    assert_file LAYOUT, "<html><body><%= yield %><%= critiqs_tag %></body></html>\n"
  end

  test "without the layout, says what to add and writes nothing" do
    output = run_generator
    assert_no_file LAYOUT
    assert_match "Add <%= critiqs_tag %> just before </body>", output
  end

  test "with more than one </body>, writes nothing" do
    source = "<body>\n</body>\n<body>\n</body>\n"
    write_layout(source)
    output = run_generator
    assert_file LAYOUT, source
    assert_match "2 </body> tags", output
  end

  test "adds the tag before the page's </body>, not one inside ERB code, an ERB comment, an HTML comment or a script" do
    source = STARTER.sub("    <%= yield %>\n", <<~ERB.gsub(/^/, "    "))
      <%= yield %>
      <%= content_for?(:footer) ? "</body>" : "" %>
      <%# </body> %>
      <!-- </body> -->
      <script>document.write("</body>")</script>
    ERB
    write_layout(source)
    run_generator
    assert_file LAYOUT, source.sub("</script>\n", "</script>\n    <%= critiqs_tag %>\n")
  end

  test "when the only </body> is inside ERB code, writes nothing" do
    source = %(<html>\n  <body>\n    <%= yield %>\n  <%= "</body>".html_safe %>\n</html>\n)
    write_layout(source)
    output = run_generator
    assert_file LAYOUT, source
    assert_match "0 </body> tags", output
  end

  test "an ERB tag that never closes, writes nothing" do
    source = STARTER.sub("<%= yield %>", "<%= yield")
    write_layout(source)
    output = run_generator
    assert_file LAYOUT, source
    assert_match "never closes", output
  end

  test "critiqs_tag in an ERB comment isn't Critiqs set up" do
    write_layout(STARTER.sub("<%= yield %>", "<%= yield %>\n    <%# critiqs_tag goes here %>"))
    run_generator
  end

  test "tells the person to set CRITIQS_PROJECT_ID" do
    write_layout(STARTER)
    assert_match "CRITIQS_PROJECT_ID", run_generator
  end

  # Production loads only Bundler's default group (BUNDLE_WITHOUT=development:test),
  # and a page calling a helper it doesn't load fails there.
  {
    "a development group block" => GEMFILE.sub(%(gem "critiqs-rails"\n), %(group :development do\n  gem "critiqs-rails"\nend\n)),
    "the development and test group" => GEMFILE.sub(%(\ngem "critiqs-rails"\n), "").sub(%(  gem "debug"), %(  gem "critiqs-rails"\n  gem "debug")),
    "a group on the next line" => GEMFILE.sub(%(gem "critiqs-rails"), %(gem "critiqs-rails",\n  group: :development)),
    "require: false on the next line" => GEMFILE.sub(%(gem "critiqs-rails"), %(gem "critiqs-rails",\n  require: false)),
    "platforms on the next line" => GEMFILE.sub(%(gem "critiqs-rails"), %(gem "critiqs-rails",\n  platforms: :jruby)),
    "no declaration at all" => GEMFILE.sub(%(gem "critiqs-rails"\n), ""),
  }.each do |name, gemfile|
    test "refuses when the Gemfile has the gem in #{name}, since production wouldn't load critiqs_tag" do
      write_gemfile(gemfile)
      write_layout(STARTER)
      output = run_generator
      assert_file LAYOUT, STARTER
      assert_match %(gem "critiqs-rails"), output
      assert_match "outside any group", output
      refute_match "CRITIQS_PROJECT_ID is set", output
    end
  end

  # A condition Bundler checks when it installs or loads gems can hold while
  # setup runs and fail in production (ENABLE_CRITIQS=1 here), so setup
  # refuses any condition around the declaration, not only one that fails now.
  {
    "an install_if block" => %(install_if -> { ENV["ENABLE_CRITIQS"] == "1" } do\n  gem "critiqs-rails"\nend\n),
    "an install_if option" => %(gem "critiqs-rails", install_if: -> { ENV["ENABLE_CRITIQS"] == "1" }\n),
    "an env block" => %(env "ENABLE_CRITIQS" do\n  gem "critiqs-rails"\nend\n),
    "an if block" => %(if ENV["ENABLE_CRITIQS"] == "1"\n  gem "critiqs-rails"\nend\n),
    "a trailing unless" => %(gem "critiqs-rails" unless ENV["ENABLE_CRITIQS"].nil?\n),
    "a case branch" => %(case ENV["ENABLE_CRITIQS"]\nwhen "1"\n  gem "critiqs-rails"\nend\n),
    "a platforms block for this computer's platform" => %(platforms :ruby do\n  gem "critiqs-rails"\nend\n),
  }.each do |name, declaration|
    test "refuses when the Gemfile has the gem only under #{name}, even though this computer meets it" do
      ENV["ENABLE_CRITIQS"] = "1"
      write_gemfile(GEMFILE.sub(%(gem "critiqs-rails"\n), declaration))
      write_layout(STARTER)
      output = run_generator
      assert_file LAYOUT, STARTER
      assert_match %(gem "critiqs-rails"), output
      assert_match "outside any group", output
      refute_match "CRITIQS_PROJECT_ID is set", output
    ensure
      ENV.delete("ENABLE_CRITIQS")
    end
  end

  test "refuses a condition in a Gemfile the Gemfile evaluates, naming that file's line" do
    write_gemfile(GEMFILE.sub(%(gem "critiqs-rails"\n), %(eval_gemfile "Gemfile.review"\n)))
    File.write(File.join(destination_root, "Gemfile.review"), %(# Review apps only\nif true\n  gem "critiqs-rails"\nend\n))
    write_layout(STARTER)
    output = run_generator
    assert_file LAYOUT, STARTER
    assert_match "Gemfile.review:3", output
  end

  {
    "a group :default block" => %(group :default do\n  gem "critiqs-rails"\nend\n),
    "a source block" => %(source "https://rubygems.org" do\n  gem "critiqs-rails"\nend\n),
    "a Gemfile it evaluates" => %(eval_gemfile "Gemfile.critiqs"\n),
  }.each do |name, declaration|
    test "a gem every environment loads, in #{name}, is enough" do
      write_gemfile(GEMFILE.sub(%(gem "critiqs-rails"\n), declaration))
      File.write(File.join(destination_root, "Gemfile.critiqs"), %(gem "critiqs-rails"\n))
      write_layout(STARTER)
      run_generator
      assert_match "critiqs_tag", layout
    end
  end

  test "a critiqs_tag the layout renders from a partial is Critiqs set up" do
    write_layout(STARTER.sub("<%= yield %>", %(<%= yield %>\n    <%= render "layouts/footer" %>)))
    File.write(File.join(destination_root, "app/views/layouts/_footer.html.erb"), "<footer>\n  <%= critiqs_tag %>\n</footer>\n")
    output = run_generator
    refute_match "critiqs_tag", layout
    assert_match "app/views/layouts/_footer.html.erb already has critiqs_tag", output
  end

  test "adds the tag before the page's </body>, not one in an attribute value" do
    source = STARTER.sub("<body>", %(<body data-template="</body>" title='</body>'>))
    write_layout(source)
    run_generator
    assert_file LAYOUT, source.sub("    <%= yield %>\n", "    <%= yield %>\n    <%= critiqs_tag %>\n")
  end

  test "when the only </body> is in an attribute value, writes nothing" do
    source = %(<html>\n  <body data-template="</body>">\n    <%= yield %>\n</html>\n)
    write_layout(source)
    output = run_generator
    assert_file LAYOUT, source
    assert_match "0 </body> tags", output
  end

  test "a gem declared across lines with a version and require: true is enough" do
    write_gemfile(GEMFILE.sub(%(gem "critiqs-rails"), %(gem "critiqs-rails",\n  "~> 0.3", require: true)))
    write_layout(STARTER)
    run_generator
    assert_match "critiqs_tag", layout
  end

  test "adds the tag before the page's </body>, not one in a textarea or the title" do
    source = "<html>\n  <head><title>a</body>b</title></head>\n  <body>\n    <textarea></body></textarea>\n  </body>\n</html>\n"
    write_layout(source)
    run_generator
    assert_file LAYOUT, source.sub("</textarea>\n", "</textarea>\n    <%= critiqs_tag %>\n")
  end

  test "when the only </body> is inside a textarea, writes nothing" do
    source = "<html>\n  <body>\n    <%= yield %>\n    <textarea>\n</body>\n    </textarea>\n</html>\n"
    write_layout(source)
    output = run_generator
    assert_file LAYOUT, source
    assert_match "0 </body> tags", output
  end
end
