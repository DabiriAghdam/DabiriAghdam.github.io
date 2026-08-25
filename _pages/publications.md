---
layout: page
permalink: /publications/
title: Publications
description: Peer-reviewed publications, preprints, and master's thesis by Amirhossein Dabiriaghdam.
peer_reviewed_years: [2025, 2024, 2023]
nav: true
nav_order: 1
---
<!-- _pages/publications.md -->
<div class="publications">

<p>Check out my <a href="https://scholar.google.com/citations?user=10ZeC3MAAAAJ" target="_blank">Google Scholar profile</a> for a complete list of publications.</p>

<h2>Peer-reviewed Publications</h2>
{%- for y in page.peer_reviewed_years %}
  <h2 class="year">{{y}}</h2>
  {% bibliography -f papers -q @*[status=peer-reviewed,year={{y}}]* %}
{% endfor %}

<h2>Preprints</h2>
{% bibliography -f papers -q @*[status=preprint]* %}

<h2>Master's Thesis</h2>
{% bibliography -f papers -q @mastersthesis %}

</div>
