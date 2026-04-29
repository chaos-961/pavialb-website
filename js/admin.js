(() => {
  const KEY = 'PAVIA_PRODUCTS';
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const form = $('[data-admin-form]');
  const list = $('[data-admin-products]');
  const count = $('[data-admin-count]');
  let products = readProducts();

  function readProducts(){
    try { return JSON.parse(localStorage.getItem(KEY)) || window.PAVIA_DEFAULT_PRODUCTS || []; }
    catch { return window.PAVIA_DEFAULT_PRODUCTS || []; }
  }
  function saveProducts(){ localStorage.setItem(KEY, JSON.stringify(products)); render(); }
  function toArray(value){ return String(value || '').split(',').map(item => item.trim()).filter(Boolean); }
  function slug(value){ return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }

  function render(){
    count.textContent = `${products.length} items`;
    list.innerHTML = products.map(product => `
      <article class="admin-row">
        <img src="${product.image}" alt="${product.name}">
        <div>
          <h3>${product.name}</h3>
          <p>${product.category} · $${product.price} · ${product.stock} in stock</p>
          <p>${product.sizes.join(', ')} · ${product.colors.join(', ')}</p>
        </div>
        <div class="admin-actions">
          <button type="button" data-edit="${product.id}">Edit</button>
          <button type="button" data-delete="${product.id}">Delete</button>
        </div>
      </article>
    `).join('');
    $$('[data-edit]').forEach(button => button.addEventListener('click', () => editProduct(button.dataset.edit)));
    $$('[data-delete]').forEach(button => button.addEventListener('click', () => deleteProduct(button.dataset.delete)));
  }

  function editProduct(id){
    const product = products.find(item => item.id === id);
    if(!product) return;
    form.id.value = product.id;
    form.name.value = product.name;
    form.category.value = product.category;
    form.price.value = product.price;
    form.compareAt.value = product.compareAt || '';
    form.badge.value = product.badge || '';
    form.image.value = product.image;
    form.description.value = product.description;
    form.sizes.value = product.sizes.join(', ');
    form.colors.value = product.colors.join(', ');
    form.stock.value = product.stock;
    form.featured.value = String(Boolean(product.featured));
    window.scrollTo({top:0, behavior:'smooth'});
  }

  function deleteProduct(id){
    if(!confirm('Delete this product from the local demo catalog?')) return;
    products = products.filter(product => product.id !== id);
    saveProducts();
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(form);
    const product = {
      id: data.get('id') || slug(data.get('name')) || `product-${Date.now()}`,
      name: data.get('name'),
      category: data.get('category'),
      price: Number(data.get('price')),
      compareAt: Number(data.get('compareAt') || 0),
      badge: data.get('badge') || 'New',
      image: data.get('image'),
      description: data.get('description'),
      sizes: toArray(data.get('sizes')),
      colors: toArray(data.get('colors')),
      stock: Number(data.get('stock')),
      featured: data.get('featured') === 'true'
    };
    const existingIndex = products.findIndex(item => item.id === product.id);
    if(existingIndex >= 0) products[existingIndex] = product;
    else products.unshift(product);
    saveProducts();
    form.reset();
    form.id.value = '';
  });

  $('[data-new-product]').addEventListener('click', () => { form.reset(); form.id.value = ''; });
  $('[data-reset-products]').addEventListener('click', () => {
    if(!confirm('Reset all products to the original demo catalog?')) return;
    products = window.PAVIA_DEFAULT_PRODUCTS || [];
    localStorage.removeItem(KEY);
    render();
  });

  render();
})();
