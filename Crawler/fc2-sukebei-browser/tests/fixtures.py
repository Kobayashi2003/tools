"""Minimal HTML samples mirroring the live markup of each source (structure verified 2026-10)."""


def listing_row(view_id, name, infohash, row_class="default", size="1.8 GiB", ts=1791484390,
                seeders=5, leechers=11, downloads=3):
    return f"""
<tr class="{row_class}">
  <td><a href="/?c=2_2" title="Real Life - Videos"><img src="/static/img/icons/sukebei/2_2.png" alt="Real Life - Videos" class="category-icon"></a></td>
  <td colspan="2">
    <a href="/view/{view_id}#comments" class="comments" title="2 comments"><i class="fa fa-comments-o"></i>2</a>
    <a href="/view/{view_id}" title="{name}">{name}</a>
  </td>
  <td class="text-center">
    <a href="/download/{view_id}.torrent"><i class="fa fa-fw fa-download"></i></a>
    <a href="magnet:?xt=urn:btih:{infohash}&amp;dn=x&amp;tr=http%3A%2F%2Fsukebei.tracker.wf%3A8888%2Fannounce"><i class="fa fa-fw fa-magnet"></i></a>
  </td>
  <td class="text-center">{size}</td>
  <td class="text-center" data-timestamp="{ts}">2026-10-08 18:33</td>
  <td class="text-center">{seeders}</td>
  <td class="text-center">{leechers}</td>
  <td class="text-center">{downloads}</td>
</tr>"""


def listing_page(rows, total=1000, has_next=True):
    nxt = '<li class="next"><a href="/?f=0&c=0_0&q=FC2&p=2">&raquo;</a></li>' if has_next else \
        '<li class="next disabled unavailable"><a>&raquo;</a></li>'
    return f"""<html><body><div class="pagination-page-info">Displaying results 1-75 out of {total} results.</div>
<table><tbody>{''.join(rows)}</tbody></table><ul class="pagination">{nxt}</ul></body></html>"""


LISTING = listing_page([
    listing_row(4732175, "fc2-ppv-4802589 藻梨特典有 &amp; more", "68B8F9604D16DAE11CB76C52990C54BDDB80B070"),
    listing_row(4732100, "[FHD] FC2 PPV 1289686 (UNCENSORED 2160p)", "aa" * 20, row_class="success",
                size="512.3 MiB", seeders=0),
    listing_row(4732099, "Some other release 2160p", "bb" * 20, row_class="danger"),
])

VIEW = """
<div class="panel-body" id="torrent-description">https://imagetwist.com/x/y.png &amp; notes</div>
</div>
<div class="panel panel-default">
  <div class="torrent-file-list panel-body">
    <ul>
      <li>
        <a href="" class="folder"><i class="fa fa-folder-open"></i>fc2-ppv-4802589 root</a>
        <ul data-show="yes">
          <li>
            <a href="" class="folder"><i class="fa fa-folder"></i>ads</a>
            <ul>
              <li><i class="fa fa-file"></i>installer.exe <span class="file-size">(6.0 MiB)</span></li>
              <li><i class="fa fa-file"></i>site.url <span class="file-size">(49 Bytes)</span></li>
            </ul>
          </li>
          <li><i class="fa fa-file"></i>FC2-PPV-4802589.mp4 <span class="file-size">(1.6 GiB)</span></li>
          <li><i class="fa fa-file"></i>game.apk <span class="file-size">(8.5 MiB)</span></li>
        </ul>
      </li>
    </ul>
  </div>
</div>"""

FC2_ARTICLE = """<html><head>
<meta property="og:title" content="FC2-PPV-4802589 美巨乳&amp;JD">
<meta property="og:image" content="https://storage200000.contents.fc2.com/file/369/36874019/1.png">
</head><body>
<div class="items_article_MainitemThumb"><span><img src="//contents-thumbnail2.fc2.com/w276/storage200000.contents.fc2.com/file/369/36874019/1.png" alt="x"><p class="items_article_info">01:36:30</p></span></div>
<div class="items_article_headerInfo" data-section="userInfo"><h3>title</h3><ul>
<li>by <a href="https://adult.contents.fc2.com/users/bisirichn/" data-article-seller-name>美尻ちゃんねる</a></li>
<li class="items_article_StarA"><a href="/article/4802589/review" class="items_article_Stars"><p><span class="items_article_Star4"></span></p></a></li></ul></div>
<section><a class="tag tagTag" data-article-tag href="/search/?tag=a" data-tag="ハメ撮り">ハメ撮り</a>
<a class="tag tagTag" data-article-tag href="/search/?tag=b" data-tag="JD">JD</a>
<a class="tag tagTag" data-article-tag href="/search/?tag=b" data-tag="JD">JD</a></section>
<div class="items_article_softDevice"><p>販売日 : 2025/11/23</p></div>
<ul class="items_article_SampleImagesArea" data-feed="sample-images">
<li><span>1</span><a href="//contents-thumbnail2.fc2.com/w1280/storage200000.contents.fc2.com/file/369/36874019/2.jpeg" data-image-slideshow="sample-images" data-pdp-sample-thumbnail><img src="//contents-thumbnail2.fc2.com/w480/storage200000.contents.fc2.com/file/369/36874019/2.jpeg"></a></li>
<li><span>2</span><a href="//contents-thumbnail2.fc2.com/w1280/storage200000.contents.fc2.com/file/369/36874019/3.jpeg" data-image-slideshow="sample-images" data-pdp-sample-thumbnail><img src="x"></a></li>
</ul>
<section class="items_article_Review" id="review"><h3>商品レビュー<span>(81)</span></h3></section>
<div class="recommend"><a href="//contents-thumbnail2.fc2.com/w1280/other.jpeg">not a sample</a></div>
</body></html>"""

FC2_REMOVED = "<html><head><title>お探しの商品が見つかりませんでした | FC2コンテンツマーケット</title></head></html>"

PAIPANCON = """<html><body>
<h2 class="text-center">FC2-PPV-4802589 - 美巨乳JD</h2>
<img class="media-item" src="/fc2daily/data/FC2-PPV-4802589/thumbnail_1.jpg">
<img class="media-item" src="/fc2daily/data/FC2-PPV-4802589/grid.jpg">
<img class="media-item" src="/fc2daily/data/FC2-PPV-4802589/cover.jpg">
<img class="media-item" src="/fc2daily/data/FC2-PPV-4802589/thumbnail_0.jpg">
<video class="media-item" src="/fc2daily/data/FC2-PPV-4802589/bbb.mp4"></video>
<video class="media-item" src="/fc2daily/data/FC2-PPV-4802589/aaa.mp4"></video>
<a href="/fc2daily/detail/FC2-PPV-1111111"><img src="/fc2daily/data/FC2-PPV-1111111/cover.jpg"></a>
</body></html>"""
