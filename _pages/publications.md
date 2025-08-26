---
layout: page
permalink: /publications/
title: Publications
description: 
years: [2025, 2024, 2023]
nav: true
nav_order: 1
---
<!-- _pages/publications.md -->
<div class="publications">

<p>Check out my <a href="https://scholar.google.com/citations?user=10ZeC3MAAAAJ" target="_blank">Google Scholar profile</a> for a complete list of publications.</p>

{%- for y in page.years %}
  <h2 class="year">{{y}}</h2>
  {% bibliography -f papers -q @*[year={{y}}]* %}
{% endfor %}

</div>
