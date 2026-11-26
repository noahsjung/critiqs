from django.http import HttpResponse
from django.template import engines
from django.urls import include, path, re_path, register_converter


class MyInt:
    regex = "[0-9]+"

    def to_python(self, value):
        return int(value)

    def to_url(self, value):
        return str(value)


register_converter(MyInt, "my-int")


def page(request, **kwargs):
    source = request.GET.get("template", "{% load critiqs %}{% critiqs %}")
    return HttpResponse(engines["django"].from_string(f"<body>{source}</body>").render({}, request))


urlpatterns = [
    path("", page),
    path("users/<int:id>/", page),
    path("docs/<path:rest>", page),
    path("items/<my-int:id>/", page),
    path("teams/<int:id>/", page, {"internal": "do-not-publish"}),
    re_path(r"^archive/(?P<year>[0-9]{4})/$", page),
    # Parameters captured at every level of include(), with extra kwargs at each level.
    path(
        "orgs/<slug:org>/",
        include([path("teams/<int:team>/", include([path("items/<int:id>/", page, {"leaf": "do-not-publish"})]), {"middle": "do-not-publish"})]),
        {"outer": "do-not-publish"},
    ),
]
